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
            target: {tabId: tab.id}, func: () => {
                window.__scraperShouldStop = true;
            }
        });

        showAndFade(notice, "Stopped.", "red");
    });

    // scrape button logic
    scrapeBtn.addEventListener("click", async () => {
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});

        const url = tab.url;
        const validTwitterFollowing = /^https:\/\/(x\.com|twitter\.com)\/[^/]+\/following$/;

        if (!validTwitterFollowing.test(url)) {
            showAndFade(notice, "Collection Disabled. Please navigate to your Twitter following page.", "red");
            return;
        }

        // prevent concurrent runs by checking the tab context
        const [{result: isRunning}] = await chrome.scripting.executeScript({
            target: {tabId: tab.id}, func: () => window.__scraperRunning === true
        });

        if (isRunning) {
            showAndFade(notice, "Scraper is running. Press stop to cancel.", "orange");
            return;
        }

        const scrollStep = parseInt(document.getElementById("scrollSlider").value, 10);
        const sleepTime = parseInt(document.getElementById("sleepSlider").value, 10);

        scrapeBtn.disabled = true;
        status.textContent = "Scraper running...";

        await chrome.scripting.executeScript({
            target: {tabId: tab.id}, func: (scrollStep, sleepTime) => {
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
                        console.log("stopped by user.");
                        window.__scraperRunning = false;
                        return;
                    }

                    chrome.runtime.sendMessage({
                        type: "scrape-complete", count: handles.size
                    });

                    console.log(Array.from(handles).join("\n"));
                    const handlesArray = Array.from(handles);

                    // save values to chrome.storage
                    chrome.storage.local.set({scrapedHandles: handlesArray}, () => {
                        console.log('handles saved to storage.');

                        chrome.runtime.sendMessage({type: "scrape-saved"});
                    });
                    window.__scraperRunning = false;
                })();
            }, args: [scrollStep, sleepTime]
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
            showAndFade(status, "Stored followings cleared.", "gray");
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
    const boothMap = await fetchBoothMappings();

    const {scrapedHandles} = await chrome.storage.local.get("scrapedHandles");
    if (!scrapedHandles || scrapedHandles.length === 0) {
        showAndFade(notice, "No stored handles found.", "red");
        return;
    }

    const cleanedScraped = scrapedHandles.map(h => h.replace(/^@/, ''));
    const matches = cleanedScraped.filter(h => sheetHandles.includes(h));
    document.getElementById("return").textContent = `${matches.length} match(es) found with AX AA database.`;

    const matchesDiv = document.getElementById("matchesList");
    const boothIds = [];

    let output = '';
    for (const match of matches) {
        const booth = boothMap.get(match.toLowerCase());
        if (booth) {
            output += `${match} → ${booth}\n`;
            boothIds.push(booth);
        } else {
            console.warn(`[WARN] no booth mapping found for: ${match}`);
        }
    }

    matchesDiv.textContent = output.length ? output : "No matching handles found.";

    // Add compact booth export
    if (boothIds.length > 0) {
        const grouped = {};

        for (const booth of boothIds) {
            const match = booth.match(/^([A-Za-z])(\d{2})$/);
            if (match) {
                const letter = match[1].toUpperCase();
                const number = match[2];
                if (!grouped[letter]) grouped[letter] = [];
                grouped[letter].push(number);
            }
        }

        const letters = Object.keys(grouped).sort();
        for (const letter of letters) {
            grouped[letter].sort(); // sort booth numbers numerically as strings
        }

        // build final string
        const compactExport = letters.map(letter => letter + grouped[letter].join('')).join('');
        matchesDiv.textContent += `\n\nBooths: ${compactExport}`;
    }

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
        console.error("error fetching sheet", err);
        showAndFade(notice, "Failed to fetch sheet", "red");
        return [];
    }
}

async function fetchBoothMappings() {
    const {artistSheetUrl} = await loadConfig();

    try {
        const res = await fetch(artistSheetUrl);
        const text = await res.text();
        const rows = parseSheet(text);

        const boothMap = new Map();

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const booth = row[2]?.trim(); // Column C
            const links = row[5]?.trim(); // Column F

            if (!booth || !links) continue;

            const handle = extractHandle(links);
            if (handle) boothMap.set(handle.toLowerCase(), booth);
        }

        return boothMap;
    } catch (err) {
        console.error("error fetching artist sheet", err);
        document.getElementById("notice").textContent = "Failed to fetch artist booth data.";
        return new Map();
    }
}

function parseSheet(sheet) {
    const rows = [];
    let current = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < sheet.length; i++) {
        const char = sheet[i];
        const nextChar = sheet[i + 1];

        if (char === '"' && inQuotes && nextChar === '"') {
            field += '"';
            i++;
        } else if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            current.push(field);
            field = '';
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
            if (field || current.length > 0) current.push(field);
            field = '';
            if (current.length > 1) rows.push(current);
            current = [];
            if (char === '\r' && nextChar === '\n') i++;
        } else {
            field += char;
        }
    }

    if (field || current.length > 0) current.push(field);
    if (current.length > 1) rows.push(current);

    return rows;
}

function extractHandle(field) {
    if (!field) return null;
    const links = field.split(/[\s\r\n]+/);
    for (const link of links) {
        const match = link.trim().match(/^https?:\/\/(www\.)?(x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})(\/)?$/);
        if (match) return match[3];
    }
    return null;
}

// text fading
function showAndFade(element, message, color = "", duration = 3000) {
    element.textContent = message;
    if (color) element.style.color = color;

    // Ensure the element is visible
    element.style.opacity = 1;

    setTimeout(() => {
        element.style.transition = "opacity 1s";
        element.style.opacity = 0;

        setTimeout(() => {
            element.textContent = "";
            element.style.opacity = 1; // reset for next use
            element.style.transition = "";
        }, 1000);
    }, duration);
}

