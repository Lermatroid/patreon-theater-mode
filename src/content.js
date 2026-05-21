(() => {
  const STATE = {
    active: false,
    video: null,
    playerRoot: null,
    stageElements: [],
    buttonHost: null,
    nativeButtonAnchor: null,
    button: null,
    observer: null,
    syncTimer: null,
    theaterContentLeft: null,
    theaterAspectRatio: null
  };

  const ATTR_PLAYER = "data-patreon-theater-player";
  const ATTR_STAGE = "data-patreon-theater-stage";
  const ATTR_MODE = "data-patreon-theater-mode";
  const ATTR_FULLSCREEN = "data-patreon-theater-fullscreen";
  const BUTTON_CLASS = "patreon-theater-toggle";
  const VIDEO_SELECTOR = "video, iframe[src*='youtube.com'], iframe[src*='vimeo.com']";

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 120 && rect.height > 80 && rect.bottom > 0 && rect.right > 0;
  }

  function visibleArea(element) {
    const rect = element.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    return width * height;
  }

  function findBestVideo() {
    const candidates = [...document.querySelectorAll(VIDEO_SELECTOR)].filter(isVisible);

    return candidates
      .map((element) => ({
        element,
        score:
          visibleArea(element) +
          (element.tagName === "VIDEO" && !element.paused ? window.innerWidth * window.innerHeight : 0)
      }))
      .sort((a, b) => b.score - a.score)[0]?.element ?? null;
  }

  function findNativeFullscreenButton() {
    const buttons = [...document.querySelectorAll("button")].filter(
      (button) => !button.classList.contains(BUTTON_CLASS)
    );

    return (
      buttons.find((button) => {
        const label = [
          button.getAttribute("aria-label"),
          button.getAttribute("title"),
          button.textContent
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return /full\s*screen|fullscreen/.test(label);
      }) ?? null
    );
  }

  function nearestCommonAncestor(first, second) {
    if (!first || !second) return null;

    const firstAncestors = new Set();
    let current = first;

    while (current) {
      firstAncestors.add(current);
      current = current.parentElement;
    }

    current = second;
    while (current) {
      if (firstAncestors.has(current)) return current;
      current = current.parentElement;
    }

    return null;
  }

  function findNativePlayerRoot(video) {
    const fullscreenButton = findNativeFullscreenButton();
    const sharedRoot = nearestCommonAncestor(video, fullscreenButton);

    STATE.nativeButtonAnchor = fullscreenButton;

    if (!sharedRoot) return null;

    const videoRect = video.getBoundingClientRect();
    let best = sharedRoot;
    let current = sharedRoot;

    while (current && current !== document.body && current !== document.documentElement) {
      const rect = current.getBoundingClientRect();
      const heightRatio = rect.height / videoRect.height;
      const widthRatio = rect.width / videoRect.width;
      const text = (current.textContent ?? "").replace(/\s+/g, " ").trim();

      if (
        rect.width >= videoRect.width &&
        rect.height >= videoRect.height &&
        heightRatio <= 1.28 &&
        widthRatio <= 1.35 &&
        !/Home Posts Collections Membership Gift/.test(text)
      ) {
        best = current;
      }

      current = current.parentElement;
    }

    return best;
  }

  function rootScore(element, videoRect) {
    const rect = element.getBoundingClientRect();
    const area = rect.width * rect.height;
    const videoArea = videoRect.width * videoRect.height;
    const heightRatio = rect.height / videoRect.height;
    const widthRatio = rect.width / videoRect.width;

    if (rect.width < videoRect.width || rect.height < videoRect.height) return -Infinity;
    if (rect.height > window.innerHeight * 0.72) return -Infinity;
    if (heightRatio > 1.35) return -Infinity;
    if (widthRatio > 1.45) return -Infinity;
    if (area < videoArea * 0.95) return -Infinity;

    const className = typeof element.className === "string" ? element.className : "";
    const role = element.getAttribute("role") ?? "";
    const label = element.getAttribute("aria-label") ?? "";
    const content = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    const text = `${className} ${role} ${label}`.toLowerCase();
    const playerHint = /player|video|media|embed/.test(text) ? 50000 : 0;
    const pageChromePenalty = /Home Posts Collections Membership Gift/.test(content) ? 1000000 : 0;
    const proximity = Math.abs(area - videoArea * 1.08);

    return playerHint - pageChromePenalty - proximity;
  }

  function findPlayerRoot(video) {
    const nativeRoot = findNativePlayerRoot(video);
    if (nativeRoot) return nativeRoot;

    const videoRect = video.getBoundingClientRect();
    let best = video;
    let bestScore = -Infinity;
    let current = video;

    while (current && current !== document.body && current !== document.documentElement) {
      const score = rootScore(current, videoRect);

      if (score > bestScore) {
        best = current;
        bestScore = score;
      }

      current = current.parentElement;
    }

    return best;
  }

  function clearPlayerRoot() {
    if (STATE.playerRoot) {
      STATE.playerRoot.removeAttribute(ATTR_PLAYER);
    }
    STATE.playerRoot = null;
  }

  function clearVideoStage() {
    for (const element of STATE.stageElements) {
      element.removeAttribute(ATTR_STAGE);
    }
    STATE.stageElements = [];
  }

  function videoAspectRatio(video) {
    if (video instanceof HTMLVideoElement && video.videoWidth > 0 && video.videoHeight > 0) {
      return video.videoWidth / video.videoHeight;
    }

    const rect = video.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return rect.width / rect.height;
    }

    return 16 / 9;
  }

  function markVideoStage(video, root) {
    clearVideoStage();

    video.setAttribute(ATTR_STAGE, "media");
    STATE.stageElements.push(video);

    const frame = video.parentElement;
    if (frame && frame !== root) {
      frame.setAttribute(ATTR_STAGE, "frame");
      STATE.stageElements.push(frame);
    }

    let current = frame?.parentElement;
    while (current && current !== root && current !== document.body && current !== document.documentElement) {
      current.setAttribute(ATTR_STAGE, "box");
      STATE.stageElements.push(current);
      current = current.parentElement;
    }
  }

  function setButtonHost(host, beforeNode = null) {
    if (!STATE.button || (STATE.buttonHost === host && STATE.button.nextElementSibling === beforeNode)) return;
    STATE.buttonHost = host;

    if (beforeNode && beforeNode.parentElement === host) {
      beforeNode.before(STATE.button);
      STATE.button.classList.add("is-in-native-controls");
    } else {
      host.append(STATE.button);
      STATE.button.classList.remove("is-in-native-controls");
    }
  }

  function setPlayerRoot(root) {
    if (STATE.playerRoot === root) return;
    clearPlayerRoot();
    STATE.playerRoot = root;
    if (STATE.playerRoot) {
      STATE.playerRoot.setAttribute(ATTR_PLAYER, "true");
      if (STATE.video) {
        markVideoStage(STATE.video, STATE.playerRoot);
      }
      if (STATE.nativeButtonAnchor?.parentElement) {
        setButtonHost(STATE.nativeButtonAnchor.parentElement, STATE.nativeButtonAnchor);
      } else {
        setButtonHost(STATE.playerRoot);
      }
    }
  }

  function ensureButton() {
    if (STATE.button) return STATE.button;

    const button = document.createElement("button");
    button.className = BUTTON_CLASS;
    button.type = "button";
    button.title = "Toggle theater mode";
    button.setAttribute("aria-label", "Toggle Patreon theater mode");
    button.innerHTML = `
      <span class="patreon-theater-toggle__icon" aria-hidden="true"></span>
      <span class="patreon-theater-toggle__label">Theater</span>
    `;
    button.addEventListener("click", () => toggleTheater());

    STATE.button = button;
    updateButton();
    return button;
  }

  function updateButton() {
    if (!STATE.button) return;
    STATE.button.hidden = !STATE.video;
    STATE.button.setAttribute("aria-pressed", String(STATE.active));
    STATE.button.classList.toggle("is-active", STATE.active);
  }

  function clearTheaterVariables() {
    document.documentElement.style.removeProperty("--patreon-theater-width");
    document.documentElement.style.removeProperty("--patreon-theater-height");
    document.documentElement.style.removeProperty("--patreon-theater-aspect");
  }

  function isNativeFullscreen() {
    return Boolean(document.fullscreenElement);
  }

  function applyTheaterLayout() {
    if (!STATE.active || !STATE.playerRoot || isNativeFullscreen()) return;

    const contentLeft =
      STATE.theaterContentLeft ?? Math.max(0, Math.round(STATE.playerRoot.getBoundingClientRect().left));
    const width = Math.round(window.innerWidth - contentLeft);
    const aspectRatio = STATE.theaterAspectRatio ?? videoAspectRatio(STATE.video);
    const height = Math.round(width / aspectRatio);

    document.documentElement.style.setProperty("--patreon-theater-width", `${width}px`);
    document.documentElement.style.setProperty("--patreon-theater-height", `${height}px`);
    document.documentElement.style.setProperty("--patreon-theater-aspect", String(aspectRatio));
  }

  function setTheaterMode(active) {
    if (active && isNativeFullscreen()) {
      return;
    }

    const wasActive = STATE.active;
    STATE.active = active;

    if (active && !wasActive && STATE.playerRoot) {
      STATE.theaterContentLeft = Math.max(0, Math.round(STATE.playerRoot.getBoundingClientRect().left));
      STATE.theaterAspectRatio = videoAspectRatio(STATE.video);
    }

    if (!active) {
      STATE.theaterContentLeft = null;
      STATE.theaterAspectRatio = null;
    }

    document.documentElement.toggleAttribute(ATTR_MODE, active);

    if (active && STATE.playerRoot) {
      applyTheaterLayout();
    } else {
      clearTheaterVariables();
    }

    updateButton();
  }

  function toggleTheater() {
    if (!STATE.video) sync();
    if (!STATE.video) return;
    setTheaterMode(!STATE.active);
  }

  function sync() {
    const video = findBestVideo();
    STATE.video = video;

    if (video) {
      ensureButton();
      setPlayerRoot(findPlayerRoot(video));
      if (STATE.playerRoot) {
        markVideoStage(video, STATE.playerRoot);
      }
    } else {
      setTheaterMode(false);
      clearPlayerRoot();
      clearVideoStage();
    }

    applyTheaterLayout();

    updateButton();
  }

  function scheduleSync() {
    window.clearTimeout(STATE.syncTimer);
    STATE.syncTimer = window.setTimeout(sync, 150);
  }

  function onKeydown(event) {
    const target = event.target;
    const isTyping =
      target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

    if (isTyping) return;

    if (event.key.toLowerCase() === "t") {
      event.preventDefault();
      toggleTheater();
    }

    if (event.key === "Escape" && STATE.active) {
      setTheaterMode(false);
    }
  }

  function onFullscreenChange() {
    const fullscreen = isNativeFullscreen();
    document.documentElement.toggleAttribute(ATTR_FULLSCREEN, fullscreen);

    if (fullscreen) {
      if (STATE.active) {
        setTheaterMode(false);
      } else {
        clearTheaterVariables();
      }
      return;
    }

    scheduleSync();
  }

  function init() {
    document.documentElement.removeAttribute(ATTR_MODE);
    document.documentElement.removeAttribute(ATTR_FULLSCREEN);
    clearTheaterVariables();
    document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((button) => button.remove());

    sync();

    STATE.observer = new MutationObserver(scheduleSync);
    STATE.observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    window.addEventListener("resize", scheduleSync);
    window.addEventListener("keydown", onKeydown);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.setInterval(sync, 2500);
  }

  init();
})();
