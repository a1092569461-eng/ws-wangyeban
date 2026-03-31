async function addMessage(data){
  const allCodes = extractAllTaoCodes(data);
  const now = Date.now();
  const source = data.group_name || data.group_id || '未知来源';
  const contentPreview = cleanContent(data.raw_message || data.message || '').substring(0, 25);

  const hash = getContentHash(data);
  const normalizedText = getNormalizedText(data);

  console.log(`[DEBUG] hash=${hash} norm=${normalizedText} codes=${JSON.stringify(allCodes)}`);

  const hasImages = extractImages(data).length > 0;
  if (!hasImages && checkTextDuplicate(hash, normalizedText, source, now)) {
    log(`[已过滤] ${source}\n${contentPreview}...`);
    return;
  }

  // Extract JD product IDs from URLs
  const jdIds = await extractJDProductIds(data);
  console.log(`[DEBUG] JD IDs=${JSON.stringify(jdIds)}`);
  
  // Fetch Taobao product IDs for codes
  let productResults = [];
  if (allCodes.length > 0) {
    for (const code of allCodes) {
      const id = await fetchProductId('￥' + code + '￥');
      if (id) productResults.push({ code, productId: id });
    }
  }
  
  // Add JD IDs to productResults
  jdIds.forEach(id => productResults.push({ code: null, productId: id }));
  
  console.log(`[DEBUG] allProductIds=${JSON.stringify(productResults.map(r => r.productId))} trackerKeys=${JSON.stringify([...productDuplicateTracker.keys()])}`);
  
  // Check for existing product duplicates
  const existingProductIds = productResults.filter(r => productDuplicateTracker.has(r.productId));
  if (existingProductIds.length > 0) {
    for (const { productId } of existingProductIds) {
      const pInfo = productDuplicateTracker.get(productId);
      if (pInfo && !pInfo.groups.includes(source)) {
        pInfo.groups.push(source);
        pInfo.count = pInfo.groups.length;
      }
      if (pInfo && pInfo.card) {
        updateCardProductTag(pInfo.card, pInfo);
        updateAllGroupsTag(pInfo.card);
      }
    }
    log(`[同商品] ${source}\n${contentPreview}...`);
    return;
  }

  globalMsgId++;
  data.local_id = globalMsgId;

  savedMessages.push(data);
  if(savedMessages.length > 500) savedMessages = savedMessages.slice(-500);
  saveMessages();
  
  if(msgCount === 0){
    messagesDiv.innerHTML = '';
  }
  msgCount++;
  countSpan.textContent = msgCount;

   const hlResult = hlIsHighlight(data, allCodes);
   const newProductIds = productResults.map(r => r.productId).filter(id => id);
   const matchReason = hlResult.reasons.length > 0 ? `[${hlResult.reasons.join(', ')}]` : '';
   const card = createMsgCard(data, { contentDupInfo: { count: 1, groups: [source] }, productDupInfo: null, productIds: newProductIds, isHighlight: hlResult.triggered, highlightKeywords: hlResult.keywords, matchReason: matchReason });

   const wasAtBottomBefore = document.body.scrollHeight - window.scrollY - window.innerHeight < 50;

   // 根据显示模式决定是否显示消息
   if (displayMode === 'highlight' && !hlResult.triggered) {
     // 仅显示重点消息时，非重点消息直接跳过
     return;
   }

   messagesDiv.appendChild(card);

  for (const productId of newProductIds) {
    if (productId) {
      productDuplicateTracker.set(productId, {
        productId,
        content: data.raw_message || data.message || '',
        count: 1,
        groups: [source],
        firstTime: now,
        lastTime: now,
        card: card
      });
    }
  }
  
  if (wasAtBottomBefore) {
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
    });
    const imgs = card.querySelectorAll('img');
    if (imgs.length > 0) {
      let loaded = 0;
      imgs.forEach(img => {
        if (img.complete) loaded++;
        else img.addEventListener('load', () => { loaded++; if (loaded === imgs.length) requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })); }, { once: true });
      });
    }
    unreadCount = 0;
    unreadBadge.classList.remove('show');
    messagesDiv.querySelectorAll('[data-unread="true"]').forEach(el => el.removeAttribute('data-unread'));
  } else {
    card.dataset.unread = 'true';
    unreadCount++;
    unreadBadge.textContent = unreadCount > 99 ? '99+' : `获取到新消息 ${unreadCount}`;
    unreadBadge.classList.add('show');
  }
  
  duplicateTracker.set(hash, {
    content: data.raw_message || data.message || '',
    normalizedText: normalizedText,
    count: 1,
    groups: [source],
    firstTime: now,
    lastTime: now,
    card: card
  });
  
  log(`[新消息] #${globalMsgId} ${source}\n${contentPreview}...`);
  
}

function cleanupDuplicateTracker(){
  const now = Date.now();
  for(const [hash, info] of duplicateTracker){
    if(now - info.lastTime > DEDUP_DURATION){
      // 如果卡片已从DOM移除，先删除card属性
      if (info.card && !info.card.parentNode) {
        delete info.card;
      }
      duplicateTracker.delete(hash);
    }
  }
  for(const [productId, info] of productDuplicateTracker){
    if(now - info.lastTime > DEDUP_DURATION){
      if (info.card && !info.card.parentNode) {
        delete info.card;
      }
      productDuplicateTracker.delete(productId);
    }
  }
  for(const [jdId, info] of jdDuplicateTracker){
    if(now - info.lastTime > DEDUP_DURATION){
      if (info.card && !info.card.parentNode) {
        delete info.card;
      }
      jdDuplicateTracker.delete(jdId);
    }
  }
}

  function saveMessages(){
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try{
        const dataStr = JSON.stringify(savedMessages);
        if(dataStr.length > 2 * 1024 * 1024){
          const seen = new Set();
          savedMessages = savedMessages.reverse().filter(msg => {
            const hash = getContentHash(msg);
            if(seen.has(hash)) return false;
            seen.add(hash);
            return true;
          }).slice(0, 500).reverse();
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(savedMessages));
        localStorage.setItem(STORAGE_URL_KEY, wsUrlInput.value);
        localStorage.setItem(STORAGE_MSG_ID_KEY, globalMsgId);
      } catch(e){ console.error('Save error:', e); }
    }, 3000);
  }
  
  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(savedMessages));
        localStorage.setItem(STORAGE_URL_KEY, wsUrlInput.value);
        localStorage.setItem(STORAGE_MSG_ID_KEY, globalMsgId);
      } catch(e) { console.error('Flush save error:', e); }
    }
  }

  function loadMessages(){
    try{
      const saved = localStorage.getItem(STORAGE_KEY);
      const savedUrl = localStorage.getItem(STORAGE_URL_KEY);
      const savedMsgId = localStorage.getItem(STORAGE_MSG_ID_KEY);
      if(saved){
        const parsed = JSON.parse(saved);
        const seen = new Set();
        savedMessages = parsed.filter(msg => {
          const hash = getContentHash(msg);
          if(seen.has(hash)) return false;
          seen.add(hash);
          return true;
        });
      }
      if(savedUrl) wsUrlInput.value = savedUrl;
      if(savedMsgId) globalMsgId = parseInt(savedMsgId) || 0;
    } catch(e){ console.error('Load error:', e); }
  }

function renderSavedMessages(){
  if(savedMessages.length > 0){
    messagesDiv.innerHTML = '';
    duplicateTracker.clear();
    
    savedMessages.forEach((msg, i) => {
      if (!msg.local_id) {
        msg.local_id = i + 1;
      }
      const hash = getContentHash(msg);
      const source = msg.group_name || msg.group_id || '未知来源';
      
      if(duplicateTracker.has(hash)){
        const info = duplicateTracker.get(hash);
        if(!info.groups.includes(source)){
          info.groups.push(source);
          info.count = info.groups.length;
        }
        updateDupTag(info.card, info);
        updateAllGroupsTag(info.card);
      } else {
        const card = createMsgCard(msg, { contentDupInfo: { count: 1, groups: [source] }, productDupInfo: null, productIds: [] });
        messagesDiv.appendChild(card);
        
        // 限制左侧面板卡片数量，防止内存泄漏
        const maxCards = 200;
        if (messagesDiv.children.length > maxCards) {
          const toRemove = messagesDiv.children.length - maxCards;
          for (let i = 0; i < toRemove; i++) {
            messagesDiv.removeChild(messagesDiv.children[0]);
          }
        }
        msgCount++;
        countSpan.textContent = msgCount;
        
        const msgNormalizedText = getNormalizedText(msg);
        duplicateTracker.set(hash, {
          content: msg.raw_message || msg.message || '',
          normalizedText: msgNormalizedText,
          count: 1,
          groups: [source],
          firstTime: Date.now(),
          lastTime: Date.now(),
          card: card
        });
      }
    });
    const scrollToBottom = () => {
      window.scrollTo(0, document.body.scrollHeight);
    };
    requestAnimationFrame(() => {
      scrollToBottom();
      // 延迟再次滚动，确保图片等资源加载后位置准确
      setTimeout(scrollToBottom, 300);
    });
  }
}

function connect(){
  const url = wsUrlInput.value.trim();
  if(!url) return;
  
  // 如果重连次数超过5次，停止自动重连
  if(reconnectCount >= 5) {
    console.log('已达到最大重连次数（5次），停止自动重连');
    return;
  }
  
  if(reconnectTimer){
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  if(ws){
    ws.close();
    ws = null;
  }
  
  updateStatus(false);
  connectBtn.disabled = true;
  
  try{
    ws = new WebSocket(url);
    
    ws.onopen = () => {
      reconnectCount = 0; // 连接成功，重置重连计数
      updateStatus(true);
      cleanupTimer = setInterval(cleanupDuplicateTracker, 60000);
      clearLog();
    };
    
    ws.onmessage = (event) => {
      try{
        const data = JSON.parse(event.data);
        if(data.post_type !== 'meta_event'){
          addMessage(data);
        }
      } catch(e){
        console.log('Parse error:', e);
      }
    };
    
    ws.onclose = () => {
      if(isManualClose){
        isManualClose = false;
        updateStatus(false);
        return;
      }
      updateStatus(false);
      if(cleanupTimer){
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      reconnectCount++;
      if(reconnectCount >= 5) {
        console.log('已达到最大重连次数（5次），停止自动重连');
        return;
      }
      reconnectTimer = setTimeout(() => {
    reconnectCount = 0; // 手动连接，重置重连计数
    connect();
      }, 3000);
    };
    
    ws.onerror = (err) => {
      console.error('WebSocket 错误:', err);
    };
  } catch(e){
    console.error('连接失败:', e);
    reconnectCount++;
    if(reconnectCount >= 5) {
      console.log('已达到最大重连次数（5次），停止自动重连');
      return;
    }
    reconnectTimer = setTimeout(() => {
      connect();
    }, 3000);
  }
}

function toggleConnect(){
  if(ws && ws.readyState === WebSocket.OPEN){
    isManualClose = true;
    ws.close();
  } else {
    connect();
  }
}

// 事件绑定
connectBtn.addEventListener('click', toggleConnect);

clearBtn.addEventListener('click', () => {
  savedMessages = [];
  duplicateTracker.clear();
  productDuplicateTracker.clear();
  jdDuplicateTracker.clear();
  msgCount = 0;
  globalMsgId = 0;
  countSpan.textContent = 0;
  unreadCount = 0;
  unreadBadge.classList.remove('show');
  messagesDiv.innerHTML = '<div class="empty">等待新消息...</div>';
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(STORAGE_MSG_ID_KEY);
  hlProductPriceMap.clear();
  clearLog();
});

wsUrlInput.addEventListener('change', saveMessages);
wsUrlInput.addEventListener('keypress', (e) => {
  if(e.key === 'Enter' && !wsUrlInput.disabled){
    connect();
  }
});

// 图片放大
imgOverlay.addEventListener('click', () => {
  imgOverlay.classList.remove('show');
});

// 上下文弹窗关闭
contextClose.addEventListener('click', () => {
  contextModal.classList.remove('show');
});

contextModal.addEventListener('click', (e) => {
  if(e.target === contextModal) {
    contextModal.classList.remove('show');
  }
});

// 事件委托
document.addEventListener('click', (e) => {
  // 图片点击放大
  if(e.target.classList.contains('msg-image') || e.target.classList.contains('ctx-img')){
    overlayImg.src = e.target.src;
    imgOverlay.classList.add('show');
  }

  // 复制按钮
  if(e.target.classList.contains('copy-btn') || e.target.classList.contains('ctx-copy-btn') || e.target.closest('.copy-btn') || e.target.closest('.ctx-copy-btn')){
    const btn = e.target.classList.contains('copy-btn') || e.target.classList.contains('ctx-copy-btn') ? e.target : (e.target.closest('.copy-btn') || e.target.closest('.ctx-copy-btn'));
    let images = [], content = '';
    if(btn.classList.contains('ctx-copy-btn')){
      images = JSON.parse(btn.closest('.ctx-item').dataset.images || '[]');
      content = btn.closest('.ctx-item').dataset.content || '';
    } else {
      images = JSON.parse(btn.dataset.images || '[]');
      content = btn.dataset.content || '';
    }
    copyContent(btn, images, content);
  }
  
  // 上下文按钮
  if(e.target.classList.contains('context-btn') || e.target.closest('.context-btn')){
    const btn = e.target.classList.contains('context-btn') ? e.target : e.target.closest('.context-btn');
    const groupId = btn.dataset.groupId || '';
    const groupName = btn.dataset.groupName || '';
    const localId = parseInt(btn.dataset.localId) || 0;
    showContextModal(groupId, groupName, localId);
  }
  
  // 重复标记展开
  if(e.target.classList.contains('dup-tag') || e.target.closest('.dup-tag')){
    const tag = e.target.classList.contains('dup-tag') ? e.target : e.target.closest('.dup-tag');
    const card = tag.closest('.msg-card');
    const groupsDiv = card.querySelector('.dup-groups');
    const groupsList = card.querySelector('.dup-groups-list');
    
    // 如果点击的是已展开的标签，则收起
    if (tag.classList.contains('expanded')) {
      tag.classList.remove('expanded');
      if (groupsDiv) groupsDiv.classList.remove('show');
    } else {
      // 收起其他标签
      card.querySelectorAll('.dup-tag.expanded').forEach(t => t.classList.remove('expanded'));
      // 展开当前标签
      tag.classList.add('expanded');
      if (groupsDiv) groupsDiv.classList.add('show');
    }
  }
  

});

loadMessages();
renderSavedMessages();

connect();
function toggleConfig() {
  const config = document.querySelector('.config');
  const statusBar = document.querySelector('.status-bar');
  const toggle = document.getElementById('configToggle');
  const isShowing = config.classList.contains('show');
  config.classList.toggle('show');
  statusBar.classList.toggle('show');
  toggle.classList.toggle('show', !isShowing);
