const https = require('https');
const http = require('http');
const url = require('url');

function fetchUrl(targetUrl) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(targetUrl);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    };

    const req = client.request(options, (res) => {
      let data = '';
      
      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log('[重定向]', res.headers.location);
        resolve(fetchUrl(res.headers.location));
        return;
      }
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        resolve({ url: targetUrl, html: data, statusCode: res.statusCode });
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

function extractJDSyncId(targetUrl) {
  console.log('[extractJDSyncId] 正在解析:', targetUrl);
  
  // /item.xxx.html → 商品ID
  const itemMatch = targetUrl.match(/\/item\.(\d{5,})/);
  if (itemMatch) {
    console.log('[extractJDSyncId] 匹配到 item.xx.html:', itemMatch[1]);
    return 'JD:' + itemMatch[1];
  }
  
  // /数字.html → 商品ID
  const cleanUrl = targetUrl.split('?')[0];
  const pathMatch = cleanUrl.match(/\/(\d{5,})\.html/);
  if (pathMatch) {
    console.log('[extractJDSyncId] 匹配到 /xx.html:', pathMatch[1]);
    return 'JD:' + pathMatch[1];
  }
  
  // 兜底：jd.com/后到?前的数字路径
  const genericMatch = targetUrl.match(/jd\.com\/(\d{5,})/i);
  if (genericMatch) {
    console.log('[extractJDSyncId] 匹配到 jd.com/xx:', genericMatch[1]);
    return 'JD:' + genericMatch[1];
  }
  
  console.log('[extractJDSyncId] 未找到商品ID');
  return null;
}

async function main() {
  const shortUrl = 'https://u.jd.com/cGEzRxK';
  console.log('=== 开始解析京东短链接 ===');
  console.log('短链接:', shortUrl);
  console.log();
  
  try {
    // 第一步：访问短链接
    console.log('--- 第一步：访问短链接 ---');
    const result1 = await fetchUrl(shortUrl);
    console.log('状态码:', result1.statusCode);
    
    // 第二步：提取 var hrl='...'
    console.log();
    console.log('--- 第二步：查找 var hrl ---');
    const hrlMatch = result1.html.match(/var hrl='([^']+)'/);
    if (!hrlMatch) {
      console.log('❌ 未找到 var hrl');
      
      // 尝试其他方式
      console.log();
      console.log('--- 尝试查找其他跳转方式 ---');
      const locationMatch = result1.html.match(/window\.location\.href\s*=\s*["']([^"']+)["']/);
      if (locationMatch) {
        console.log('找到 window.location.href:', locationMatch[1]);
        const result2 = await fetchUrl(locationMatch[1]);
        const productId = extractJDSyncId(result2.url);
        if (productId) {
          console.log();
          console.log('✅ 商品ID:', productId);
        }
      }
      return;
    }
    
    const hrlUrl = hrlMatch[1];
    console.log('✅ 找到 var hrl:', hrlUrl);
    
    // 第三步：访问 hrl 链接
    console.log();
    console.log('--- 第三步：访问 hrl 链接 ---');
    const result2 = await fetchUrl(hrlUrl);
    console.log('最终URL:', result2.url);
    
    // 第四步：提取商品ID
    console.log();
    console.log('--- 第四步：提取商品ID ---');
    const productId = extractJDSyncId(result2.url);
    
    if (productId) {
      console.log();
      console.log('====================================');
      console.log('✅ 最终商品ID:', productId);
      console.log('====================================');
    } else {
      console.log();
      console.log('❌ 无法提取商品ID');
      console.log('最终页面HTML片段:');
      console.log(result2.html.substring(0, 500));
    }
    
  } catch (error) {
    console.error('❌ 错误:', error.message);
  }
}

main();
