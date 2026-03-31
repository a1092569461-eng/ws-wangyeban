<?php
// proxy.php - 图片代理，解决防盗链和内网地址问题，增强版
// 放置在 C:\xampp\htdocs\ws-monitor\ 目录下

header('Access-Control-Allow-Origin: *');
header('X-Content-Type-Options: nosniff');

// 配置
define('CACHE_DIR', __DIR__ . '/image_cache/');
define('CACHE_TIME', 86400); // 24小时
define('MAX_FILE_SIZE', 5 * 1024 * 1024); // 5MB
define('MAX_REDIRECTS', 5);
define('RATE_LIMIT', 10); // 每分钟最多10个请求
define('RATE_LIMIT_FILE', __DIR__ . '/rate_limit.json');

// 初始化缓存目录
if (!is_dir(CACHE_DIR)) {
    mkdir(CACHE_DIR, 0755, true);
}

// 速率限制
function checkRateLimit($ip) {
    if (!file_exists(RATE_LIMIT_FILE)) {
        file_put_contents(RATE_LIMIT_FILE, json_encode([]));
    }
    $data = json_decode(file_get_contents(RATE_LIMIT_FILE), true) ?: [];
    $now = time();
    $window = 60; // 1分钟窗口
    
    // 清理过期记录
    foreach ($data as $key => $timestamp) {
        if ($now - $timestamp > $window) {
            unset($data[$key]);
        }
    }
    
    // 检查当前IP的请求次数
    $ipKey = $ip . '_';
    $count = 0;
    foreach ($data as $key => $timestamp) {
        if (strpos($key, $ipKey) === 0) {
            $count++;
        }
    }
    
    if ($count >= RATE_LIMIT) {
        http_response_code(429);
        exit('Rate limit exceeded');
    }
    
    // 记录当前请求
    $data[$ipKey . $now] = $now;
    file_put_contents(RATE_LIMIT_FILE, json_encode($data));
}

// 安全检查：禁止代理内网IP
function isPrivateIP($ip) {
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
        $privateRanges = [
            '127.0.0.0/8',
            '10.0.0.0/8',
            '172.16.0.0/12',
            '192.168.0.0/16',
            '169.254.0.0/16'
        ];
        foreach ($privateRanges as $range) {
            list($subnet, $bits) = explode('/', $range);
            $ipLong = ip2long($ip);
            $subnetLong = ip2long($subnet);
            $mask = -1 << (32 - $bits);
            if (($ipLong & $mask) == ($subnetLong & $mask)) {
                return true;
            }
        }
    } elseif (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) {
        // IPv6私有地址检查
        if (strpos($ip, 'fd') === 0 || strpos($ip, 'fc') === 0 || $ip === '::1') {
            return true;
        }
    }
    return false;
}

// 获取缓存文件路径
function getCachePath($url) {
    $hash = md5($url);
    $ext = '.jpg'; // 默认扩展名
    if (preg_match('/\.(jpg|jpeg|png|gif|webp|bmp)$/i', $url, $matches)) {
        $ext = $matches[1];
    }
    return CACHE_DIR . $hash . $ext;
}

// 清理过期缓存（每次请求都有30%概率执行）
function cleanExpiredCache() {
    if (rand(1, 100) > 30) { // 30%概率执行
        return;
    }
    $files = glob(CACHE_DIR . '*');
    $now = time();
    $deleted = 0;
    foreach ($files as $file) {
        if (is_file($file) && ($now - filemtime($file)) > CACHE_TIME) {
            @unlink($file);
            $deleted++;
        }
    }
}

// 手动清理所有缓存（通过URL参数触发）
if (isset($_GET['clear_cache']) && $_GET['clear_cache'] === '1') {
    $files = glob(CACHE_DIR . '*');
    $count = 0;
    foreach ($files as $file) {
        if (is_file($file)) {
            @unlink($file);
            $count++;
        }
    }
    header('Content-Type: text/plain; charset=utf-8');
    echo "已清理 $count 个缓存文件";
    exit;
}

// 自动清理：限制缓存文件数量最多1000个
function cleanOldestCache() {
    $files = glob(CACHE_DIR . '*');
    if (count($files) > 1000) {
        // 按修改时间排序，删除最老的
        usort($files, function($a, $b) {
            return filemtime($a) - filemtime($b);
        });
        $toDelete = count($files) - 1000;
        for ($i = 0; $i < $toDelete; $i++) {
            @unlink($files[$i]);
        }
    }
}

// 主逻辑
$url = $_GET['url'] ?? '';
if (!$url) {
    http_response_code(400);
    exit('Missing URL parameter');
}

// 速率限制（使用用户IP）
$clientIP = $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
checkRateLimit($clientIP);

// URL验证
if (!filter_var($url, FILTER_VALIDATE_URL)) {
    http_response_code(400);
    exit('Invalid URL');
}

$host = parse_url($url, PHP_URL_HOST);
if (!$host) {
    http_response_code(400);
    exit('Invalid URL host');
}

// 内网IP检查
$ip = gethostbyname($host);
if (isPrivateIP($ip)) {
    http_response_code(403);
    exit('Private IP not allowed');
}

// 缓存检查
$cachePath = getCachePath($url);
if (file_exists($cachePath) && (time() - filemtime($cachePath)) < CACHE_TIME) {
    $cached = file_get_contents($cachePath);
    if ($cached !== false) {
        // 根据文件扩展名设置Content-Type
        $ext = pathinfo($cachePath, PATHINFO_EXTENSION);
        $mimeTypes = [
            'jpg' => 'image/jpeg',
            'jpeg' => 'image/jpeg',
            'png' => 'image/png',
            'gif' => 'image/gif',
            'webp' => 'image/webp',
            'bmp' => 'image/bmp'
        ];
        $contentType = $mimeTypes[$ext] ?? 'image/jpeg';
        header('Content-Type: ' . $contentType);
        header('Cache-Control: max-age=3600');
        header('X-Cache: HIT');
        echo $cached;
        exit;
    }
}

// 下载图片
$ch = curl_init();
curl_setopt_array($ch, [
    CURLOPT_URL => $url,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS => MAX_REDIRECTS,
    CURLOPT_SSL_VERIFYPEER => false,
    CURLOPT_SSL_VERIFYHOST => false,
    CURLOPT_TIMEOUT => 15,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    CURLOPT_REFERER => '',
    CURLOPT_HTTPHEADER => [
        'Accept: image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language: zh-CN,zh;q=0.9',
    ]
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
$size = curl_getinfo($ch, CURLINFO_SIZE_DOWNLOAD);
curl_close($ch);

// 清理过期缓存（后台任务）
cleanExpiredCache();
cleanOldestCache();

if ($httpCode == 200 && $response && $size <= MAX_FILE_SIZE) {
    // 保存缓存
    file_put_contents($cachePath, $response);
    
    // 设置正确的Content-Type
    if (strpos($contentType, 'image/') === 0) {
        header('Content-Type: ' . $contentType);
    } else {
        // 根据文件内容检测MIME类型
        $finfo = finfo_open(FILEINFO_MIME_TYPE);
        $mime = finfo_buffer($finfo, $response);
        finfo_close($finfo);
        if (strpos($mime, 'image/') === 0) {
            header('Content-Type: ' . $mime);
        } else {
            header('Content-Type: image/jpeg');
        }
    }
    header('Cache-Control: max-age=3600');
    header('X-Cache: MISS');
    echo $response;
} else {
    // 返回占位图
    header('Content-Type: image/gif');
    header('Cache-Control: no-cache');
    echo base64_decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
}
