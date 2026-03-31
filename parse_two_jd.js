const https = require('https');
const http = require('http');

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
  
  const itemMatch = targetUrl.match(/\/item\.(\d{5,})/);
  if (itemMatch) {
    console.log('[extractJDSyncId] 匹配到 item.xx.html:', itemMatch[1]);
    return 'JD:' + itemMatch[1];
  }
  
  const cleanUrl = targetUrl.split('?')[0];
  const pathMatch = cleanUrl.match(/\/(\d{5,})\.html/);
  if (pathMatch) {
    console.log('[extractJDSyncId] 匹配到 /xx.html:', pathMatch[1]);
    return 'JD:' + pathMatch[1];
  }
  
  const productMatch = cleanUrl.match(/\/product\/(\d{5,})\.html/);
  if (productMatch) {
    console.log('[extractJDSyncId] 匹配到 /product/xx.html:', productMatch[1]);
    return 'JD:' + productMatch[1];
  }
  
  const genericMatch = targetUrl.match(/jd\.com\/(\d{5,})/i);
  if (genericMatch) {
    console.log('[extractJDSyncId] 匹配到 jd.com/xx:', genericMatch[1]);
    return 'JD:' + genericMatch[1];
  }
  
  console.log('[extractJDSyncId] 未找到商品ID');
  return null;
}

async function parseShortUrl(shortUrl, label) {
  console.log();
  console.log('====================================');
  console.log(`解析 ${label}:`, shortUrl);
  console.log('====================================');
  
  try {
    const result1 = await fetchUrl(shortUrl);
    console.log('状态码:', result1.statusCode);
    
    let hrlMatch = result1.html.match(/var hrl='([^']+)'/);
    if (hrlMatch) {
      console.log('✅ 找到 var hrl:', hrlMatch[1]);
      const result2 = await fetchUrl(hrlMatch[1]);
      console.log('最终URL:', result2.url);
      const productId = extractJDSyncId(result2.url);
      if (productId) {
        console.log();
        console.log('✅ 最终商品ID:', productId);
        return productId;
      }
    } else {
      console.log('❌ 未找到 var hrl');
      
      const locationMatch = result1.html.match(/window\.location\.href\s*=\s*["']([^"']+)["']/);
      if (locationMatch) {
        console.log('✅ 找到 window.location.href:', locationMatch[1]);
        const result2 = await fetchUrl(locationMatch[1]);
        console.log('最终URL:', result2.url);
        const productId = extractJDSyncId(result2.url);
        if (productId) {
          console.log();
          console.log('✅ 最终商品ID:', productId);
          return productId;
        }
      }
    }
    
    console.log();
    console.log('❌ 无法提取商品ID');
    console.log('HTML片段:');
    console.log(result1.html.substring(0, 1000));
    return null;
    
  } catch (error) {
    console.error('❌ 错误:', error.message);
    return null;
  }
}

async function main() {
  const id1 = await parseShortUrl('https://u.jd.com/c6ExROk', '链接1');
  const id2 = await parseShortUrl('https://u.jd.com/cDJLsFW', '链接2');
  
  console.log();
  console.log('====================================');
  console.log('总结:');
  console.log('链接1商品ID:', id1 || '无');
  console.log('链接2商品ID:', id2 || '无');
  console.log('是否相同:', id1 && id2 && id1 === id2);
  console.log('====================================');
}

main();
