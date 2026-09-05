// Service worker: keep lightweight. Popup talks to chrome.cookies directly.
chrome.runtime.onInstalled.addListener(() => {
  console.log("Suno Cookie Extractor installed");
});
