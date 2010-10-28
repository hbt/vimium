 // Chromium #15242 will make this XHR request to access the manifest unnecessary.
  var manifestRequest = new XMLHttpRequest();
  manifestRequest.open("GET", chrome.extension.getURL("manifest.json"), false);
  manifestRequest.send(null);

  var currentVersion = JSON.parse(manifestRequest.responseText).version;

  var tabQueue = {}; // windowId -> Array
  var openTabs = {}; // tabId -> object with various tab properties
  var keyQueue = ""; // Queue of keys typed
  var validFirstKeys = {};
  var singleKeyCommands = [];
  var focusedFrame = null;
  var framesForTab = {};

  // used to track which tab is selected
  var lastSelectedTabId = null;
  var selectedTabId = null;

  var Tabs = {
     markedId: null
  };

  // Keys are either literal characters, or "named" - for example <a-b> (alt+b), <left> (the left arrow) or <f12>
  // This regular expression captures two groups, the first is a named key, the second is the remainder of the string.
  var namedKeyRegex = /^(<[amc-].|(?:[amc]-)?[a-z0-9]{2,5}>)(.*)$/;

  var defaultSettings = {
    scrollStepSize: 60,
    defaultZoomLevel: 100,
    linkHintCharacters: "sadfjklewcmpgh",
    userDefinedLinkHintCss:
      ".vimiumHintMarker {\n\n}\n" +
      ".vimiumHintMarker > .matchingCharacter {\n\n}"
  };

  // This is the base internal link hints CSS. It's combined with the userDefinedLinkHintCss before
  // being sent to the frontend.
  var linkHintCss =
    '.internalVimiumHintMarker {' +
      'position:absolute;' +
      'background-color:yellow;' +
      'color:black;' +
      'font-weight:bold;' +
      'font-size:12px;' +
      'padding:0 1px;' +
      'line-height:100%;' +
      'width:auto;' +
      'display:block;' +
      'border:1px solid #E3BE23;' +
      'z-index:99999999;' +
      'font-family:"Helvetica Neue", "Helvetica", "Arial", "Sans";' +
      'top:-1px;' +
      'left:-1px;' +
    '}' +
    '.internalVimiumHintMarker > .matchingCharacter {' +
      'color:#C79F0B;' +
    '}';


  // Port handler mapping
  var portHandlers = {
    keyDown:              handleKeyDown,
    returnScrollPosition: handleReturnScrollPosition,
    getCurrentTabUrl:     getCurrentTabUrl,
    getZoomLevel:         getZoomLevel,
    saveZoomLevel:        saveZoomLevel,
    getSetting:           getSetting
  };

  var sendRequestHandlers = {
    getCompletionKeys: getCompletionKeys,
    getLinkHintCss: getLinkHintCss,
    getKeyMarks: getKeyMarks,
    openUrlInNewTab: openUrlInNewTab,
    openUrlInCurrentTab: openUrlInCurrentTab,
    openOptionsPageInNewTab: openOptionsPageInNewTab,
    registerFrame: registerFrame,
    saveTabKeyMark:        saveTabKeyMark,
    gotoTabKeyMark: gotoTabKeyMark,
    frameFocused: handleFrameFocused,
    upgradeNotificationClosed: upgradeNotificationClosed,
    updateScrollPosition: handleUpdateScrollPosition,
    copyToClipboard: copyToClipboard,
    isEnabledForUrl: isEnabledForUrl
  };

  // Event handlers
  var selectionChangedHandlers = [];
  var getScrollPositionHandlers = {}; // tabId -> function(tab, scrollX, scrollY);
  var tabLoadedHandlers = {}; // tabId -> function()

  chrome.extension.onConnect.addListener(function(port, name) {
    var senderTabId = port.sender.tab ? port.sender.tab.id : null;
    // If this is a tab we've been waiting to open, execute any "tab loaded" handlers, e.g. to restore
    // the tab's scroll position. Wait until domReady before doing this; otherwise operations like restoring
    // the scroll position will not be possible.
    if (port.name == "domReady" && senderTabId != null) {
      if (tabLoadedHandlers[senderTabId]) {
        var toCall = tabLoadedHandlers[senderTabId];
        // Delete first to be sure there's no circular events.
        delete tabLoadedHandlers[senderTabId];
        toCall.call();
      }

      // domReady is the appropriate time to show the "vimium has been upgraded" message.
      // TODO: This might be broken on pages with frames.
      if (shouldShowUpgradeMessage())
        chrome.tabs.sendRequest(senderTabId, { name: "showUpgradeNotification", version: currentVersion });
    }

    if (portHandlers[port.name])
      port.onMessage.addListener(portHandlers[port.name]);

  });

  chrome.extension.onRequest.addListener(function (request, sender, sendResponse) {
    var senderTabId = sender.tab ? sender.tab.id : null;
    if (sendRequestHandlers[request.handler])
      sendResponse(sendRequestHandlers[request.handler](request, sender));
  });

  function handleReturnScrollPosition(args) {
    if (getScrollPositionHandlers[args.currentTab.id]) {
      // Delete first to be sure there's no circular events.
      var toCall = getScrollPositionHandlers[args.currentTab.id];
      delete getScrollPositionHandlers[args.currentTab.id];
      toCall(args.currentTab, args.scrollX, args.scrollY);
    }
  }

  /*
   * Used by the content scripts to get their full URL. This is needed for URLs like "view-source:http:// .."
   * because window.location doesn't know anything about the Chrome-specific "view-source:".
   */
  function getCurrentTabUrl(args, port) {
    var returnPort = chrome.tabs.connect(port.tab.id, { name: "returnCurrentTabUrl" });
    returnPort.postMessage({ url: port.tab.url });
  }

  /*
   * Checks the user's preferences in local storage to determine if Vimium is enabled for the given URL.
   */
  function isEnabledForUrl(request) {
    // excludedUrls are stored as a series of URL expressions separated by newlines.
    var excludedUrls = (localStorage["excludedUrls"] || "").split("\n");
    var isEnabled = true;
    for (var i = 0; i < excludedUrls.length; i++) {
      // The user can add "*" to the URL which means ".*"
      var regexp = new RegExp("^" + excludedUrls[i].replace(/\*/g, ".*") + "$");
      if (request.url.match(regexp))
        isEnabled = false;
    }
    return { isEnabledForUrl: isEnabled };
  }

  /*
   * Returns the previously saved zoom level for the current tab, or the default zoom level
   */
  function getZoomLevel(args, port) {
    var returnPort = chrome.tabs.connect(port.tab.id, { name: "returnZoomLevel" });
    var localStorageKey = "zoom" + args.domain;
    var zoomLevelForDomain = (localStorage[localStorageKey] || "").split(",")[1];
    var zoomLevel = parseInt(zoomLevelForDomain || localStorage["defaultZoomLevel"] ||
        defaultSettings.defaultZoomLevel);
    returnPort.postMessage({ zoomLevel: zoomLevel });
  }

  function showHelp(callback, frameId) {
    chrome.tabs.getSelected(null, function(tab) {
      chrome.tabs.sendRequest(tab.id, { name: "showHelpDialog", dialogHtml: helpDialogHtml(), frameId:frameId });
    });
  }

  /*
   * Retrieves the help dialog HTML template from a file, and populates it with the latest keybindings.
   */
  function helpDialogHtml(showUnboundCommands, showCommandNames, customTitle) {
    var commandsToKey = {};
    for (var key in keyToCommandRegistry) {
      var command = keyToCommandRegistry[key].command;
      commandsToKey[command] = (commandsToKey[command] || []).concat(key);
    }
    var dialogHtml = fetchFileContents("helpDialog.html");
    for (var group in commandGroups)
      dialogHtml = dialogHtml.replace("{{" + group + "}}",
          helpDialogHtmlForCommandGroup(group, commandsToKey, availableCommands,
                                        showUnboundCommands, showCommandNames));
    dialogHtml = dialogHtml.replace("{{version}}", currentVersion);
    dialogHtml = dialogHtml.replace("{{title}}", customTitle || "Help");
    return dialogHtml;
  }

  /*
   * Generates HTML for a given set of commands. commandGroups are defined in commands.js
   */
  function helpDialogHtmlForCommandGroup(group, commandsToKey, availableCommands,
                                         showUnboundCommands, showCommandNames) {
    var html = [];
    for (var i = 0; i < commandGroups[group].length; i++) {
      var command = commandGroups[group][i];
      bindings = (commandsToKey[command] || [""]).join(", ")
      if (showUnboundCommands || commandsToKey[command])
      {
        html.push("<tr><td>", escapeHtml(bindings),
          "</td><td>:</td><td>", availableCommands[command].description);

        if (showCommandNames)
          html.push("<span class='commandName'>(" + command + ")</span>");

        html.push("</td></tr>");
      }
    }
    return html.join("\n");
  }

  function escapeHtml(string) { return string.replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  /*
   * Fetches the contents of a file bundled with this extension.
   */
  function fetchFileContents(extensionFileName) {
    var req = new XMLHttpRequest();
    req.open("GET", chrome.extension.getURL(extensionFileName), false); // false => synchronous
    req.send();
    return req.responseText;
  }

  /**
   * Returns the keys that can complete a valid command given the current key queue.
   */
  function getCompletionKeys(request) {
    return {completionKeys: generateCompletionKeys("")};
  }

  /**
   * Opens the url in a new tab.
   */
  function openUrlInNewTab(request) {
    chrome.tabs.getSelected(null, function(tab) {
      chrome.tabs.create({ url: request.url, index: tab.index + 1 });
    });
  }

  /**
    * Opens the url in the current tab.
    */
   function openUrlInCurrentTab(request) {
     chrome.tabs.getSelected(null, function(tab) {
       chrome.tabs.update(tab.id, {url: request.url});
     });
   }

  /*
   * Returns the core CSS used for link hints, along with any user-provided overrides.
   */
  function getLinkHintCss(request) {
    return { linkHintCss: linkHintCss + (localStorage['userDefinedLinkHintCss'] || "") };
  }

  function saveTabKeyMark(request) {
      chrome.tabs.getSelected(null, function (tab) {
          console.log('Saving ' + tab.id + ' as ' + request.keyMark);
          localStorage['tab-keymark-' + request.keyMark] = tab.id;
      });
  }

  function gotoTabKeyMark(request) {
     var key = 'tab-keymark-' + request.keyMark;
     if (localStorage[key] != undefined) {
         // TODO: focus window too if tab is in another window
         chrome.tabs.update(parseInt(localStorage[key]), {selected: true});
     }
  }

  /*
   * Returns the assigned bookmarks.
   */
  function getKeyMarks(request) {
    return { keyMarks: localStorage['keyMarks'] || "" };
  }

  /*
   * Called when the user has clicked the close icon on the "Vimium has been updated" message.
   * We should now dismiss that message in all tabs.
   */
  function upgradeNotificationClosed(request) {
    localStorage.previousVersion = currentVersion;
    sendRequestToAllTabs({ name: "hideUpgradeNotification" });
  }

  /*
   * Copies some data (request.data) to the clipboard.
   */
  function copyToClipboard(request) {
    Clipboard.copy(request.data);
  }

  /*
   * Used by the content scripts to get settings from the local storage.
   */
  function getSetting(args, port) {
    var value = localStorage[args.key] ? localStorage[args.key] : defaultSettings[args.key];

    var returnPort = chrome.tabs.connect(port.tab.id, { name: "returnSetting" });
    returnPort.postMessage({ key: args.key, value: value });
  }

  /*
   * Persists the current zoom level for a given domain
   */
  function saveZoomLevel(args) {
    var localStorageKey = "zoom" + args.domain;
    // TODO(philc): We might want to consider expiring these entries after X months as NoSquint does.
    // Note(philc): We might also want to jsonify this hash instead of polluting our local storage keyspace.
    localStorage[localStorageKey] = [getCurrentTimeInSeconds(), args.zoomLevel].join(",");
  }

  function getCurrentTimeInSeconds() { Math.floor((new Date()).getTime() / 1000); }

  chrome.tabs.onSelectionChanged.addListener(function(tabId, selectionInfo) {
    if (selectionChangedHandlers.length > 0) { selectionChangedHandlers.pop().call(); }
    lastSelectedTabId = selectedTabId;
    selectedTabId = tabId;
  });

  function repeatFunction(func, totalCount, currentCount, frameId) {
    if (currentCount < totalCount)
      func(function() { repeatFunction(func, totalCount, currentCount + 1, frameId); }, frameId);
  }

  // Returns the scroll coordinates of the given tab. Pass in a callback of the form:
  //   function(tab, scrollX, scrollY) { .. }
  function getScrollPosition(tab, callback) {
    getScrollPositionHandlers[tab.id] = callback;
    var scrollPort = chrome.tabs.connect(tab.id, { name: "getScrollPosition" });
    scrollPort.postMessage({currentTab: tab});
  }

  // Start action functions
  function createTab(callback) {
    chrome.tabs.create({}, function(tab) { callback(); });
  }

  // detaches tab into a new window
  function detachTab(callback) {
      // retrieve current tab
      chrome.tabs.getSelected(null, function(selectedTab) {
          // create a new window
          chrome.windows.create({}, function (window) {
            // move current tab into new window
            chrome.tabs.move(selectedTab.id, {windowId: window.id, index: 0 }, function (tab) {
                // retrieve selected tab and remove it.
                // Note: an extra tab is created when creating a new window
                chrome.tabs.getSelected(null, function (newSelectedTab) {
                    if (newSelectedTab.index != 0) {
                        chrome.tabs.remove(newSelectedTab.id);
                    }
                    selectionChangedHandlers.push(callback);
                });
            });
          });
      });
  }

  function goToLastSelectedTab(callback) {
    chrome.tabs.update(lastSelectedTabId, { selected: true });
    selectionChangedHandlers.push(callback);
  }

  // moves selected tab to the left
  function moveTabLeft(callback) {
      moveTab(callback, "left");
  }

  // moves selected tab to the right
  function moveTabRight(callback) {
    moveTab(callback, "right");
  }

  /**
   * Moves the selected tab
   * @param position : values are "left" or "right"
   **/
  function moveTab(callback, position) {
    chrome.tabs.getSelected(null, function(selectedTab) {
          chrome.tabs.getAllInWindow(null, function (tabs) {
              if (tabs.length == 1) // only one tab
                  return;

              var newIndex;
              if (position == "right") {
                  if (selectedTab.index == tabs[tabs.length - 1].index) // is this the last tab?
                      newIndex = 0;
                  else
                      newIndex = selectedTab.index + 1; // move to the right
              } else {
                  if (selectedTab.index == 0)
                      newIndex = tabs[tabs.length - 1].index + 1; // move to the end right
                  else
                      newIndex = selectedTab.index - 1; // move to the left
              }

              chrome.tabs.move(selectedTab.id, { index: newIndex }, callback);
          });
      });
  }

  /**
  * closes tabs based on direction
  * @param direction : values are "all", "right", "left"
  * i.e close tabs "all" tabs, close tabs on the "right/left"
  */
  function closeTabs(callback, direction) {
    chrome.tabs.getSelected(null, function(selectedTab) {
        chrome.tabs.getAllInWindow(null, function (tabs) {
            var condition = null;

            for (var i = 0; i < tabs.length; i++) {
                if (direction == "right") {
                    condition = tabs[i].index > selectedTab.index;
                } else if (direction == "left") {
                    condition = tabs[i].index < selectedTab.index;
                } else if (direction == "all") {
                    condition = tabs[i].index != selectedTab.index;
                }

                if (condition) {
                    chrome.tabs.remove(tabs[i].id);
                }
            }
        });
    });
  }

  // marks the selected tab. Ready to be yanked
  function markTab()
  {
      chrome.tabs.getSelected(null, function (tab) {
          Tabs.markedId = tab.id;
      });
  }

  // moves the marked tab next to the selected one 
  function putTab()
  {
      if (Tabs.markedId != null) {
          chrome.tabs.getSelected(null, function(currentTab) {
              var newIndex = currentTab.index + 1;
              chrome.tabs.move(Tabs.markedId, { windowId : currentTab.windowId, index: newIndex });
              Tabs.markedId = null;
          });
      }
  }

  // closes other windows except the current one
  function closeOtherWindows(callback) {
    chrome.windows.getAll(null, function (windows) {
        chrome.windows.getCurrent(function (currentWindow) {
            for (var i = 0; i < windows.length; i++) {
                if (windows[i].id != currentWindow.id) {
                    chrome.windows.remove(windows[i].id);
                }
            }
        });
    });
  }

  // closes other tabs except the current one -- selected one
  function closeOtherTabs(callback) {
    closeTabs(callback, "all");
  }

  // closes tabs on the right of the selected tab
  function closeRightTabs(callback) {
    closeTabs(callback, "right");
  }

  // closes tabs on the left of the selected tab
  function closeLeftTabs(callback) {
    closeTabs(callback, "left");
  }

  function nextTab(callback) { selectTab(callback, "next"); }
  function previousTab(callback) { selectTab(callback, "previous"); }

  /*
   * Selects a tab before or after the currently selected tab. Direction is either "next" or "previous".
   */
  function selectTab(callback, direction) {
    chrome.tabs.getAllInWindow(null, function(tabs) {
      if (tabs.length <= 1)
        return;
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].selected) {
          var delta = (direction == "next") ? 1 : -1;
          var toSelect = tabs[(i + delta + tabs.length) % tabs.length];
          selectionChangedHandlers.push(callback);
          chrome.tabs.update(toSelect.id, { selected: true }, callback);
          break;
        }
      }
    });
  }

  function removeTab(callback) {
    chrome.tabs.getSelected(null, function(tab) {
      chrome.tabs.remove(tab.id);
      // We can't just call the callback here because we actually need to wait
      // for the selection to change to consider this action done.
      selectionChangedHandlers.push(callback);
    });
  }

  function goToOptionsPage(callback) {
      chrome.tabs.create({url: 'options.html'});
  }

  function updateOpenTabs(tab) {
    openTabs[tab.id] = { url: tab.url, positionIndex: tab.index, windowId: tab.windowId };
  }

  function handleUpdateScrollPosition(request, sender) {
    updateScrollPosition(sender.tab, request.scrollX, request.scrollY);
  }

  function updateScrollPosition(tab, scrollX, scrollY) {
    openTabs[tab.id].scrollX = scrollX;
    openTabs[tab.id].scrollY = scrollY;
  }


  chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
    if (changeInfo.status != "loading") { return; } // only do this once per URL change
    updateOpenTabs(tab);
  });

  chrome.tabs.onAttached.addListener(function(tabId, attachedInfo) {
    // We should update all the tabs in the old window and the new window.
    if (openTabs[tabId]) {
      updatePositionsAndWindowsForAllTabsInWindow(openTabs[tabId].windowId);
    }
    updatePositionsAndWindowsForAllTabsInWindow(attachedInfo.newWindowId);
  });

  chrome.tabs.onMoved.addListener(function(tabId, moveInfo) {
    updatePositionsAndWindowsForAllTabsInWindow(moveInfo.windowId);
  });

  chrome.tabs.onRemoved.addListener(function(tabId) {
    var openTabInfo = openTabs[tabId];
    updatePositionsAndWindowsForAllTabsInWindow(openTabInfo.windowId);

    // If we restore chrome:// pages, they'll ignore Vimium keystrokes when they reappear.
    // Pretend they never existed and adjust tab indices accordingly.
    // Could possibly expand this into a blacklist in the future
    if (/^chrome[^:]*:\/\/.*/.test(openTabInfo.url)) {
      for (var i in tabQueue[openTabInfo.windowId]) {
        if (tabQueue[openTabInfo.windowId][i].positionIndex > openTabInfo.positionIndex)
          tabQueue[openTabInfo.windowId][i].positionIndex--;
      }
      return;
    }

    if (tabQueue[openTabInfo.windowId])
      tabQueue[openTabInfo.windowId].push(openTabInfo);
    else
      tabQueue[openTabInfo.windowId] = [openTabInfo];

    delete openTabs[tabId];
    delete framesForTab[tabId];
  });

  chrome.windows.onRemoved.addListener(function(windowId) {
    delete tabQueue[windowId];
  });

  function restoreTab(callback) {
    // TODO(ilya): Should this be getLastFocused instead?
    chrome.windows.getCurrent(function(window) {
      if (tabQueue[window.id] && tabQueue[window.id].length > 0)
      {
        var tabQueueEntry = tabQueue[window.id].pop();

        // Clean out the tabQueue so we don't have unused windows laying about.
        if (tabQueue[window.id].length == 0)
          delete tabQueue[window.id];

        // We have to chain a few callbacks to set the appropriate scroll position. We can't just wait until the
        // tab is created because the content script is not available during the "loading" state. We need to
        // wait until that's over before we can call setScrollPosition.
        chrome.tabs.create({ url: tabQueueEntry.url, index: tabQueueEntry.positionIndex }, function(tab) {
          tabLoadedHandlers[tab.id] = function() {
            var scrollPort = chrome.tabs.connect(tab.id, {name: "setScrollPosition"});
            scrollPort.postMessage({ scrollX: tabQueueEntry.scrollX, scrollY: tabQueueEntry.scrollY });
          };

          callback();
        });
      }
    });
  }
  // End action functions

  function updatePositionsAndWindowsForAllTabsInWindow(windowId) {
    chrome.tabs.getAllInWindow(windowId, function (tabs) {
      for (var i = 0; i < tabs.length; i++) {
        var tab = tabs[i];
        var openTabInfo = openTabs[tab.id];
        if (openTabInfo) {
          openTabInfo.positionIndex = tab.index;
          openTabInfo.windowId = tab.windowId;
        }
      }
    });
  }

  function splitKeyIntoFirstAndSecond(key) {
    if (key.search(namedKeyRegex) == 0)
        return { first: RegExp.$1, second: RegExp.$2 };
    else
      return { first: key[0], second: key.slice(1) };
  }

  function getActualKeyStrokeLength(key) {
    if (key.search(namedKeyRegex) == 0)
      return 1 + getActualKeyStrokeLength(RegExp.$2);
    else
      return key.length;
  }

  function populateValidFirstKeys() {
    for (var key in keyToCommandRegistry)
    {
      if (getActualKeyStrokeLength(key) == 2)
        validFirstKeys[splitKeyIntoFirstAndSecond(key).first] = true;
    }
  }

  function populateSingleKeyCommands() {
    for (var key in keyToCommandRegistry)
    {
      if (getActualKeyStrokeLength(key) == 1)
        singleKeyCommands.push(key);
    }
  }

  function refreshCompletionKeysAfterMappingSave() {
    validFirstKeys = {};
    singleKeyCommands = [];

    populateValidFirstKeys();
    populateSingleKeyCommands();

    sendRequestToAllTabs({ name: "refreshCompletionKeys", completionKeys: generateCompletionKeys() });
  }

  /*
   * Generates a list of keys that can complete a valid command given the current key queue or the one passed
   * in.
   */
  function generateCompletionKeys(keysToCheck) {
    var splitHash = splitKeyQueue(keysToCheck);
    command = splitHash.command;
    count = splitHash.count;

    var completionKeys = [];
    for (var commandHotKey in keyToCommandRegistry) {
        if (commandHotKey.length > command.length  && commandHotKey.match("^"+ command) == command) {
            var key = commandHotKey.substring(command.length, command.length+1);
            completionKeys.push(key);
        }
    }

    return completionKeys;
  }

  function splitKeyQueue(queue) {
    var match = /([0-9]*)(.*)/.exec(queue);
    var count = parseInt(match[1]);
    var command = match[2];

    return {count: count, command: command};
  }

  function handleKeyDown(request, port) {
    var key = request.keyChar;
    if (key == "<ESC>") {
      console.log("clearing keyQueue");
      keyQueue = ""
    }
    else {
      console.log("checking keyQueue: [", keyQueue + key, "]");
      keyQueue = checkKeyQueue(keyQueue + key, port.tab.id, request.frameId);
      console.log("new KeyQueue: " + keyQueue);
    }
  }

  function checkKeyQueue(keysToCheck, tabId, frameId) {
    var refreshedCompletionKeys = false;
    var splitHash = splitKeyQueue(keysToCheck);
    command = splitHash.command;
    count = splitHash.count;

    if (command.length == 0) { return keysToCheck; }
    if (isNaN(count)) { count = 1; }

    newKeyQueue = keysToCheck;

    if (keyToCommandRegistry[command]) {
      // if we have a match, run the command and clear the key queue
      registryEntry = keyToCommandRegistry[command];
      console.log("command found for [", keysToCheck, "],", registryEntry.command);

      if (!registryEntry.isBackgroundCommand) {
        var port = chrome.tabs.connect(tabId, { name: "executePageCommand" });
        port.postMessage({ command: registryEntry.command,
                           frameId: frameId,
                           count: count,
                           passCountToFunction: registryEntry.passCountToFunction,
                           completionKeys: generateCompletionKeys("")
                         });

        refreshedCompletionKeys = true;
      } else {
        repeatFunction(this[registryEntry.command], count, 0, frameId);
        chrome.tabs.connect(tabId, { name: "backgroundCommandExecuted" });
      }

      newKeyQueue = "";
    } else {
        // check if we have at least a command starting by the queue
        newKeyQueueIsValid = false;
        for (commandHotKey in keyToCommandRegistry) {
            if (commandHotKey.match("^"+ command) == command) {
                newKeyQueueIsValid = true;
            }
        }

        if (!newKeyQueueIsValid)
            newKeyQueue = "";
    }

    // If we haven't sent the completion keys piggybacked on executePageCommand,
    // send them by themselves.
    if (!refreshedCompletionKeys)
    {
      var port = chrome.tabs.connect(tabId, { name: "refreshCompletionKeys" });
      port.postMessage({ completionKeys: generateCompletionKeys(newKeyQueue) });
    }

    return newKeyQueue;
  }

  /*
   * Message all tabs. Args should be the arguments hash used by the Chrome sendRequest API.
   */
  function sendRequestToAllTabs(args) {
    chrome.windows.getAll({ populate: true }, function(windows) {
      for (var i = 0; i < windows.length; i++)
        for (var j = 0; j < windows[i].tabs.length; j++)
          chrome.tabs.sendRequest(windows[i].tabs[j].id, args, null);
    });
  }

  // Compares two version strings (e.g. "1.1" and "1.5") and returns
  // -1 if versionA is < versionB, 0 if they're equal, and 1 if versionA is > versionB.
  function compareVersions(versionA, versionB) {
    versionA = versionA.split(".");
    versionB = versionB.split(".");
    for (var i = 0; i < Math.max(versionA.length, versionB.length); i++) {
      var a = parseInt(versionA[i] || 0);
      var b = parseInt(versionB[i] || 0);
      if (a < b) return -1;
      else if (a > b) return 1;
    }
    return 0;
  }

  /*
   * Returns true if the current extension version is greater than the previously recorded version in
   * localStorage, and false otherwise.
   */
  function shouldShowUpgradeMessage() {
    // Avoid showing the upgrade notification when localStorage.previousVersion is undefined, which is the
    // case for new installs.
    if (!localStorage.previousVersion)
      localStorage.previousVersion = currentVersion;
    return compareVersions(currentVersion, localStorage.previousVersion) == 1;
  }

  function openOptionsPageInNewTab() {
    chrome.tabs.getSelected(null, function(tab) {
      chrome.tabs.create({ url: chrome.extension.getURL("options.html"), index: tab.index + 1 });
    });
  }

  function registerFrame(request, sender) {
    if (!framesForTab[sender.tab.id])
      framesForTab[sender.tab.id] = { frames: [] };

    if (request.top) {
      focusedFrame = request.frameId;
      framesForTab[sender.tab.id].total = request.total;
    }

    framesForTab[sender.tab.id].frames.push({ id: request.frameId, area: request.area });

    // We've seen all the frames. Time to focus the largest one.
    // NOTE: Disabled because it's buggy with iframes.
    // if (framesForTab[sender.tab.id].frames.length >= framesForTab[sender.tab.id].total)
    //  focusLargestFrame(sender.tab.id);
  }

  function focusLargestFrame(tabId) {
    var mainFrameId = null;
    var mainFrameArea = 0;

    for (var i = 0; i < framesForTab[tabId].frames.length; i++) {
      var currentFrame = framesForTab[tabId].frames[i];

      if (currentFrame.area > mainFrameArea) {
        mainFrameId = currentFrame.id;
        mainFrameArea = currentFrame.area;
      }
    }

    chrome.tabs.sendRequest(tabId, { name: "focusFrame", frameId: mainFrameId, highlight: false });
  }

  function handleFrameFocused(request, sender) {
    focusedFrame = request.frameId;
  }

  function nextFrame(callback, frameId) {
    chrome.tabs.getSelected(null, function(tab) {
      var index;
      var frames = framesForTab[tab.id].frames;

      for (index=0; index < frames.length; index++) {
        if (frames[index].id == focusedFrame)
            break;
      }

      if (index >= frames.length-1)
        index = 0;
      else
        index++;

      chrome.tabs.sendRequest(tab.id, { name: "focusFrame", frameId: frames[index].id, highlight: true });
    });
  }

  function init() {
    clearKeyMappingsAndSetDefaults();

    if (localStorage["keyMappings"])
      parseCustomKeyMappings(localStorage["keyMappings"]);

    populateValidFirstKeys();
    populateSingleKeyCommands();
    if (shouldShowUpgradeMessage())
      sendRequestToAllTabs({ name: "showUpgradeNotification", version: currentVersion });

    // Ensure that openTabs is populated when Vimium is installed.
    chrome.windows.getAll({ populate: true }, function(windows) {
      for (var i in windows) {
        for (var j in windows[i].tabs) {
          var tab = windows[i].tabs[j];
          updateOpenTabs(tab);
          getScrollPosition(tab, function(tab, scrollX, scrollY) {
            // Not using the tab defined in the for loop because
            // it might have changed by the time this callback is activated.
            updateScrollPosition(tab, scrollX, scrollY);
          });
        }
      }
    });

    chrome.tabs.getSelected(null, function (selectedTab) {
      selectedTabId = selectedTab.id;
    });
  }
  init();