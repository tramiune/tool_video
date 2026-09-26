// Script to dump background state
chrome.runtime.sendMessage({ action: 'GET_PENDING_SERVER_TASKS' }, (res) => {
  console.log(JSON.stringify(res, null, 2));
});
