document.addEventListener("DOMContentLoaded", () => {
    const scrapeBtn = document.getElementById("scrapeBtn");
    const stopBtn = document.getElementById("stopBtn");
    const status = document.getElementById("status");
    const notice = document.getElementById("notice");
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    tooltipTriggerList.forEach(function (tooltipTriggerEl) {
        new bootstrap.Tooltip(tooltipTriggerEl);
    });

    // live slider label updates
    document.getElementById("scrollSlider").addEventListener("input", (e) => {
        document.getElementById("scrollVal").textContent = e.target.value;
    });

    document.getElementById("sleepSlider").addEventListener("input", (e) => {
        document.getElementById("sleepVal").textContent = e.target.value;
    });

    // message listener for scraper completion and saved event
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === "scrape-complete") {
            status.textContent = `Collected ${message.count} handles.`;
            status.style.color = "green";
        }
        if (message.type === "scrape-saved") {
            compareScrapedToSheet();
        }
    });

    // stop button logic
    stopBtn.addEventListener("click", async () => {
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});

        await chrome.scripting.executeScript({
            target: {tabId: tab.id},
            func: () => {
                window.__scraperShouldStop = true;
            }
        });

        notice.textContent = "Stopped.";
    });

    // scrape button logic
    scrapeBtn.addEventListener("click", async () => {
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});

        const url = tab.url;
        const validTwitterFollowing = /^https:\/\/(x\.com|twitter\.com)\/[^/]+\/following$/;

        if (!validTwitterFollowing.test(url)) {
            notice.textContent = "Collection Disabled. Please navigate to your Twitter following page.";
            return;
        }

        // prevent concurrent runs by checking the tab context
        const [{result: isRunning}] = await chrome.scripting.executeScript({
            target: {tabId: tab.id},
            func: () => window.__scraperRunning === true
        });

        if (isRunning) {
            notice.textContent = "Scraper is running. Press stop to cancel.";
            return;
        }

        const scrollStep = parseInt(document.getElementById("scrollSlider").value, 10);
        const sleepTime = parseInt(document.getElementById("sleepSlider").value, 10);

        scrapeBtn.disabled = true;
        status.textContent = "Scraper running...";
        status.style.color = "blue";

        await chrome.scripting.executeScript({
            target: {tabId: tab.id},
            func: (scrollStep, sleepTime) => {
                (async function () {
                    if (window.__scraperRunning) {
                        console.warn("Scraper already running.");
                        return;
                    }

                    window.__scraperRunning = true;
                    window.__scraperShouldStop = false;

                    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                    const handles = new Set();
                    const validHandleRegex = /^@([a-zA-Z0-9_]{1,15})$/;
                    const followingList = document.querySelector('div[aria-label="Timeline: Following"]');

                    function extractHandlesFromDOM() {
                        const newHandles = new Set();
                        if (!followingList) return newHandles;

                        followingList.querySelectorAll('[data-testid="UserCell"]').forEach((cell) => {
                            const handleLink = Array.from(cell.querySelectorAll('a[href^="/"]'))
                                .find((a) => {
                                    const href = a.getAttribute('href');
                                    return href && /^\/[a-zA-Z0-9_]{1,15}$/.test(href);
                                });

                            if (handleLink) {
                                const username = handleLink.getAttribute('href').slice(1);
                                const handle = '@' + username;
                                if (validHandleRegex.test(handle)) {
                                    newHandles.add(handle);
                                }
                            }
                        });

                        return newHandles;
                    }

                    extractHandlesFromDOM().forEach((h) => handles.add(h));

                    let lastHeight = document.body.scrollHeight;
                    let stableCount = 0;
                    let scrollPosition = 0;

                    while (!window.__scraperShouldStop && stableCount < 3) {
                        scrollPosition += scrollStep;
                        window.scrollTo(0, scrollPosition);
                        await sleep(sleepTime);

                        const newHandles = extractHandlesFromDOM();
                        const oldSize = handles.size;
                        newHandles.forEach((h) => handles.add(h));

                        const gotNewHandles = handles.size > oldSize;

                        const currentHeight = document.body.scrollHeight;
                        if (!gotNewHandles && currentHeight === lastHeight) {
                            stableCount++;
                        } else {
                            stableCount = 0;
                            lastHeight = currentHeight;
                        }

                        if (scrollPosition > currentHeight) break;
                    }

                    if (window.__scraperShouldStop) {
                        console.log("Stopped by user.");
                        window.__scraperRunning = false;
                        return;
                    }

                    chrome.runtime.sendMessage({
                        type: "scrape-complete",
                        count: handles.size
                    });

                    console.log(Array.from(handles).join("\n"));
                    const handlesArray = Array.from(handles);

                    // save values to chrome.storage
                    chrome.storage.local.set({scrapedHandles: handlesArray}, () => {
                        console.log('Handles saved to storage.');

                        // Notify popup script to run comparison
                        chrome.runtime.sendMessage({type: "scrape-saved"});
                    });
                    window.__scraperRunning = false;
                })();
            },
            args: [scrollStep, sleepTime]
        });

        scrapeBtn.disabled = false;
        status.textContent = "Processing... Do NOT touch or navigate away from this page.";
        status.style.color = "green";
    });

    // compare button logic
    document.getElementById("compareBtn").addEventListener("click", compareScrapedToSheet);

    // clear stored handles button
    document.getElementById("clearStorageBtn").addEventListener("click", () => {
        chrome.storage.local.remove('scrapedHandles', () => {
            console.log('cleared scrapedHandles from storage.');
            status.textContent = "Stored followings cleared.";
            status.style.color = "gray";

            // clear displayed matches or lists (this is optional)
            const matchesDiv = document.getElementById("matchesList");
            if (matchesDiv) matchesDiv.textContent = "";
        });
    });
});

// compare with google sheets
async function compareScrapedToSheet() {
    const sheetHandles = await fetchGoogleSheetHandles();

    const {scrapedHandles} = await chrome.storage.local.get("scrapedHandles");
    if (!scrapedHandles || scrapedHandles.length === 0) {
        document.getElementById("notice").textContent = "No stored handles found.";
        return;
    }

    const cleanedScraped = scrapedHandles.map(h => h.replace(/^@/, ''));
    const matches = cleanedScraped.filter(h => sheetHandles.includes(h));
    document.getElementById("return").textContent = `${matches.length} match(es) found with AX AA database.`;

    const matchesDiv = document.getElementById("matchesList");
    matchesDiv.textContent = matches.length > 0 ? matches.join('\n') : "No matching handles found.";
}

async function loadConfig() {
    const response = await fetch(chrome.runtime.getURL('extension/config.json'));
    const config = await response.json();
    return config;
}

async function fetchGoogleSheetHandles(show = false) {
    const {sheetUrl} = await loadConfig();

    try {
        const res = await fetch(sheetUrl);
        const text = await res.text();

        const rows = text.split('\n').slice(1);
        const handles = [];

        for (const row of rows) {
            const cols = row.split(',');
            if (cols[1]) handles.push(cols[1].trim());
        }

        return handles;
    } catch (err) {
        console.error("Error fetching Google Sheet:", err);
        document.getElementById("notice").textContent = "Failed to fetch sheet";
        return [];
    }
}
