// ==UserScript==
// @name         OpenReview: Active Consoles
// @namespace    https://openreview.net/
// @version      1.6.2
// @description  Hides selected active consoles and sorts the rest by your recent activity.
// @author       Nikolay Nikitin
// @license      BSD-3-Clause
// @match        https://openreview.net/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict'

  if (location.pathname !== '/') return

  const SECTION_TITLE = 'Your Active Consoles'
  const STORAGE_KEY = 'openreview-compact-active-consoles:hidden:v1'
  const STYLE_ID = 'orvc-active-consoles-style'
  const TOGGLE_ID = 'orvc-active-consoles-toggle'
  const VERSION = '1.6.2'
  const HYDRATION_POLL_MS = 100
  const HYDRATION_STABLE_MS = 2500
  const HYDRATION_TIMEOUT_MS = 30 * 1000
  let expanded = false
  let scheduled = false
  let started = false
  let activeSection = null
  let hiddenConsoleIds = loadHiddenConsoleIds()
  const consoleIdCache = new WeakMap()

  function loadHiddenConsoleIds() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
      return new Set(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [])
    } catch {
      return new Set()
    }
  }

  function saveHiddenConsoleIds() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...hiddenConsoleIds]))
    } catch {
      // The page still works if local storage is disabled; the choice just will not persist.
    }
  }

  function normalizedText(element) {
    return element?.textContent?.replace(/\s+/g, ' ').trim() || ''
  }

  function findActiveConsolesSection() {
    if (activeSection?.isConnected) return activeSection

    const heading = [...document.querySelectorAll('h1')].find(
      (element) => normalizedText(element) === SECTION_TITLE
    )
    activeSection = heading?.closest('section') || null
    return activeSection
  }

  function consoleIdFor(item) {
    const link = item.querySelector('h2 a[href]')
    const source = link?.getAttribute('href') || normalizedText(item.querySelector('h2'))
    const cached = consoleIdCache.get(item)
    if (cached?.source === source) return cached.consoleId

    let consoleId
    if (link) {
      try {
        const url = new URL(source, location.href)
        consoleId = url.searchParams.get('id') || url.pathname + url.search
      } catch {
        consoleId = source
      }
    } else {
      consoleId = source
    }

    consoleIdCache.set(item, { source, consoleId })
    return consoleId
  }

  // ============================================================================
  // OPTIONAL ACTIVITY SORTING — START
  // Delete this entire block down to the matching END marker if you do not need
  // sorting. Hide, Restore, and Show all will continue to work, and the script
  // will make no OpenReview API requests.
  // ============================================================================
  const activitySorting = (() => {
    const CACHE_KEY = 'openreview-active-consoles:activity:v2'
    const CACHE_TTL_MS = 15 * 60 * 1000
    const REQUEST_TIMEOUT_MS = 12 * 1000
    const API_URL = 'https://api2.openreview.net'
    const SORT_STYLE_ID = 'orvc-activity-sorting-style'
    let loadStarted = false
    let cache = loadCache()

    function loadCache() {
      try {
        const value = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
        return {
          fetchedAt: Number(value.fetchedAt) || 0,
          blockedUntil: Number(value.blockedUntil) || 0,
          timestamps:
            value.timestamps && typeof value.timestamps === 'object' ? value.timestamps : {},
        }
      } catch {
        return { fetchedAt: 0, blockedUntil: 0, timestamps: {} }
      }
    }

    function saveCache() {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
      } catch {
        // Sorting still works for this page load if local storage is unavailable.
      }
    }

    function venueDomainFor(consoleId) {
      const parts = consoleId.split('/').filter(Boolean)
      if (parts.length < 2) return consoleId
      parts.pop()
      return parts.join('/')
    }

    function timestampFrom(record) {
      const timestamp = Number(record?.tmdate || record?.tcdate || record?.mdate || record?.cdate)
      return Number.isFinite(timestamp) ? timestamp : 0
    }

    function timestampFor(consoleId) {
      const domain = consoleId ? venueDomainFor(consoleId) : ''
      const timestamp = Number(cache.timestamps[domain])
      return Number.isFinite(timestamp) ? timestamp : 0
    }

    function installSortingStyles() {
      if (document.getElementById(SORT_STYLE_ID)) return
      const styleHost = document.head || document.documentElement
      if (!styleHost) return
      const style = document.createElement('style')
      style.id = SORT_STYLE_ID
      style.textContent = [
        'ul.orvc-sorted-list { display: flex !important; flex-direction: column; }',
        'ul.orvc-sorted-list > li { order: var(--orvc-order, 0); }',
      ].join('\n')
      styleHost.appendChild(style)
    }

    function sortItems(list, entries) {
      installSortingStyles()
      list.classList.add('orvc-sorted-list')
      const sortedEntries = entries
        .map((entry, index) => ({
          ...entry,
          index,
          timestamp: timestampFor(entry.consoleId),
        }))
        .sort(
          (first, second) =>
            second.timestamp - first.timestamp || first.index - second.index
        )

      sortedEntries.forEach(({ item, timestamp }, index) => {
        const nextOrder = String(index)
        const nextTimestamp = String(timestamp)
        if (item.style.getPropertyValue('--orvc-order') !== nextOrder) {
          item.style.setProperty('--orvc-order', nextOrder)
        }
        if (item.dataset.orvcActivityTimestamp !== nextTimestamp) {
          item.dataset.orvcActivityTimestamp = nextTimestamp
        }
      })
    }

    async function refresh(domains) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const url = new URL('/notes/edits', API_URL)
        url.search = new URLSearchParams({
          tauthor: 'true',
          trash: 'true',
          sort: 'tmdate:desc',
          limit: '1000',
          select: 'domain,tmdate,tcdate,mdate,cdate',
        }).toString()

        const response = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'application/json,text/*;q=0.99' },
          signal: controller.signal,
        })

        if (response.status === 429) {
          const retryAfterSeconds = Number(response.headers.get('retry-after'))
          const cooldownMs = Number.isFinite(retryAfterSeconds)
            ? retryAfterSeconds * 1000
            : 60 * 60 * 1000
          cache.blockedUntil = Date.now() + cooldownMs
          saveCache()
          console.warn('[ORVC] OpenReview rate limit reached; activity sorting is paused')
          return
        }

        if (!response.ok) throw new Error('OpenReview API returned ' + response.status)

        const result = await response.json()
        const activeDomains = new Set(domains)
        const timestamps = Object.fromEntries(domains.map((domain) => [domain, 0]))

        for (const edit of result.edits || []) {
          const domain = edit.domain
          if (!activeDomains.has(domain)) continue
          timestamps[domain] = Math.max(timestamps[domain] || 0, timestampFrom(edit))
        }

        cache = { fetchedAt: Date.now(), blockedUntil: 0, timestamps }
        saveCache()
        scheduleApply()
        console.info('[ORVC] Activity order updated with one API request')
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.warn('[ORVC] Activity sorting is unavailable:', error)
        }
      } finally {
        clearTimeout(timeout)
      }
    }

    function apply(list, entries) {
      sortItems(list, entries)
      if (loadStarted) return

      const domains = [
        ...new Set(entries.map(({ consoleId }) => consoleId).filter(Boolean).map(venueDomainFor)),
      ]
      if (domains.length === 0) return
      loadStarted = true

      const now = Date.now()
      const cacheIsFresh = now - cache.fetchedAt < CACHE_TTL_MS
      const rateLimitIsActive = now < cache.blockedUntil
      if (!cacheIsFresh && !rateLimitIsActive) refresh(domains)
    }

    return { apply }
  })()
  // ============================================================================
  // OPTIONAL ACTIVITY SORTING — END
  // ============================================================================

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return
    const styleHost = document.head || document.documentElement
    if (!styleHost) return

    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = [
      'li.orvc-force-visible { display: list-item !important; }',
      'li.orvc-force-hidden { display: none !important; }',
      '.orvc-native-toggle { display: none !important; }',
      '.orvc-item-toggle {',
      '  margin-left: 0.55rem;',
      '  padding: 0;',
      '  border: 0;',
      '  background: transparent;',
      '  color: #777;',
      '  cursor: pointer;',
      '  font: inherit;',
      '  font-size: 0.72rem;',
      '  font-weight: normal;',
      '  line-height: 1;',
      '  opacity: 0.72;',
      '  vertical-align: middle;',
      '}',
      '.orvc-item-toggle:hover,',
      '.orvc-item-toggle:focus-visible {',
      '  color: #c0392b;',
      '  opacity: 1;',
      '  text-decoration: underline;',
      '}',
      'li.orvc-marked-hidden > h2 > a {',
      '  opacity: 0.55;',
      '  text-decoration: line-through;',
      '}',
      '#' + TOGGLE_ID + ' { margin-top: 0.25rem; }',
    ].join('\n')
    styleHost.appendChild(style)
  }

  function hideOpenReviewToggle(section) {
    for (const button of section.querySelectorAll('button.btn-link')) {
      if (button.id !== TOGGLE_ID && /^Show (all|fewer)\b/i.test(normalizedText(button))) {
        button.classList.add('orvc-native-toggle')
      }
    }
  }

  function addItemControl(item, consoleId) {
    const heading = item.querySelector('h2')
    if (!heading) return

    let button = heading.querySelector('.orvc-item-toggle')
    if (!button) {
      button = document.createElement('button')
      button.type = 'button'
      button.className = 'orvc-item-toggle'
      heading.appendChild(button)
    }

    button.dataset.consoleId = consoleId
    const isHidden = hiddenConsoleIds.has(consoleId)
    const label = isHidden ? 'Restore' : 'Hide'
    if (button.textContent !== label) button.textContent = label
    const title = isHidden ? 'Keep this console in the list' : 'Hide this console'
    const ariaLabel = label + ' ' + normalizedText(heading.querySelector('a'))
    if (button.title !== title) button.title = title
    if (button.getAttribute('aria-label') !== ariaLabel) {
      button.setAttribute('aria-label', ariaLabel)
    }

    if (!button.dataset.listenerAttached) {
      button.dataset.listenerAttached = 'true'
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()

        const id = button.dataset.consoleId
        if (hiddenConsoleIds.has(id)) {
          hiddenConsoleIds.delete(id)
        } else {
          hiddenConsoleIds.add(id)
        }
        saveHiddenConsoleIds()
        apply()
      })
    }
  }

  function getOrCreateToggle(section) {
    let button = document.getElementById(TOGGLE_ID)
    if (button && !section.contains(button)) button.remove()

    button = document.getElementById(TOGGLE_ID)
    if (!button) {
      button = document.createElement('button')
      button.id = TOGGLE_ID
      button.type = 'button'
      button.className = 'btn-link'
      button.addEventListener('click', () => {
        expanded = !expanded
        apply()
      })
      section.appendChild(button)
    }
    return button
  }

  function apply() {
    scheduled = false
    observer.disconnect()

    try {
      installStyles()

      const section = findActiveConsolesSection()
      if (!section) return

      const list = section.querySelector('ul.conferences')
      if (!list) return

      hideOpenReviewToggle(section)

      const items = [...list.querySelectorAll(':scope > li')]
      const entries = items.map((item) => ({ item, consoleId: consoleIdFor(item) }))

      if (typeof activitySorting !== 'undefined') activitySorting.apply(list, entries)

      let hiddenCount = 0
      for (const { item, consoleId } of entries) {
        if (!consoleId) continue

        const manuallyHidden = hiddenConsoleIds.has(consoleId)
        if (manuallyHidden) hiddenCount += 1
        const shouldShow = expanded || !manuallyHidden
        item.classList.toggle('orvc-force-visible', shouldShow)
        item.classList.toggle('orvc-force-hidden', !shouldShow)
        item.classList.toggle('orvc-marked-hidden', expanded && manuallyHidden)
        addItemControl(item, consoleId)
      }

      const toggle = getOrCreateToggle(section)
      toggle.hidden = hiddenCount === 0 && !expanded

      const nextLabel = expanded
        ? 'Show selected consoles (' + (items.length - hiddenCount) + ')'
        : 'Show all ' +
          items.length +
          ' consoles' +
          (hiddenCount ? ' (' + hiddenCount + ' hidden)' : '')
      if (toggle.textContent !== nextLabel) toggle.textContent = nextLabel
      toggle.setAttribute('aria-expanded', String(expanded))
    } finally {
      observer.observe(document, { childList: true, subtree: true })
    }
  }

  function scheduleApply() {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(apply)
  }

  const observer = new MutationObserver((mutations) => {
    if (
      !activeSection?.isConnected ||
      mutations.some((mutation) => activeSection.contains(mutation.target))
    ) {
      scheduleApply()
    }
  })

  function start() {
    if (started) return
    started = true
    observer.observe(document, { childList: true, subtree: true })
    scheduleApply()
    console.info('[ORVC] Userscript v' + VERSION + ' started after React hydration')
  }

  function isReactHydrated(element) {
    return Object.keys(element).some(
      (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactProps$')
    )
  }

  function waitForHydration() {
    const waitStartedAt = Date.now()
    let stableSection = null
    let stableSince = 0

    function check() {
      const section = findActiveConsolesSection()
      if (section && isReactHydrated(section)) {
        requestAnimationFrame(start)
        return
      }

      if (document.readyState === 'complete' && section) {
        if (section !== stableSection) {
          stableSection = section
          stableSince = Date.now()
        } else if (Date.now() - stableSince >= HYDRATION_STABLE_MS) {
          console.info('[ORVC] React marker unavailable; using stable DOM fallback')
          requestAnimationFrame(start)
          return
        }
      } else {
        stableSection = null
        stableSince = 0
      }

      if (!section && Date.now() - waitStartedAt >= HYDRATION_TIMEOUT_MS) {
        console.info('[ORVC] No active consoles section found; userscript is idle')
        return
      }

      setTimeout(check, HYDRATION_POLL_MS)
    }

    check()
  }

  console.info('[ORVC] Userscript v' + VERSION + ' loaded; waiting for React hydration')
  waitForHydration()
})()
