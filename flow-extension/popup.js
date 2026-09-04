document.getElementById('btnSidepanel').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.sidePanel.open({ tabId: tab.id });
    window.close();
  }
});

document.getElementById('btnFullTab').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
  window.close();
});

document.getElementById('btnOpenFlow').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://labs.google/fx/tools/flow' });
  window.close();
});
