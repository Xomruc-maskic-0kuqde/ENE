/**
 * ENE — analytics forwarder (provider-agnostic, privacy-aware).
 *
 * The rest of the site already dispatches `ene:analytics` CustomEvents
 * and exposes `window.eneAnalytics.track(event, props)`. This file turns
 * those events into real provider calls — without every page having to
 * know which provider is active.
 *
 * How to turn it on
 * -----------------
 * 1) Add ONE of these meta tags to the page <head> (or to a layout
 *    template once you have one):
 *
 *    <!-- Plausible (recommended — privacy-friendly, no cookies) -->
 *    <meta name="ene-analytics-provider" content="plausible">
 *    <meta name="ene-analytics-domain"   content="ene.app">
 *    <meta name="ene-analytics-host"     content="https://plausible.io">
 *
 *    <!-- OR Google Analytics 4 -->
 *    <meta name="ene-analytics-provider" content="gtag">
 *    <meta name="ene-analytics-id"       content="G-XXXXXXXX">
 *
 *    <!-- OR disable -->
 *    <meta name="ene-analytics-provider" content="none">
 *
 * 2) Include this file AFTER assets/api.js:
 *    <script src="assets/analytics.js" defer></script>
 *
 * If no meta tag is present or DNT is on, this file is a silent no-op.
 *
 * Event surface
 * -------------
 * Any code on the site can do:
 *    window.dispatchEvent(new CustomEvent('ene:analytics', {
 *      detail: { event: 'course_enroll', courseId, plan: 'track' }
 *    }));
 *
 *    // or
 *    window.eneAnalytics?.track('subscription_started', { plan, interval });
 *
 * This module forwards that to the configured provider with the same
 * event name + properties. For Plausible, `event` becomes the custom
 * event name and everything else becomes `props`. For gtag, same idea.
 */
(function () {
  'use strict';

  // ── Resolve configuration ────────────────────────────────────────
  function meta(name) {
    const el = document.querySelector('meta[name="' + name + '"]');
    return el ? (el.getAttribute('content') || '').trim() : '';
  }

  const PROVIDER = (meta('ene-analytics-provider') || '').toLowerCase();
  const DOMAIN   = meta('ene-analytics-domain');
  const HOST     = meta('ene-analytics-host') || 'https://plausible.io';
  const GA_ID    = meta('ene-analytics-id');

  // Honour Do-Not-Track unconditionally. If the user's browser is set to
  // DNT=1 we don't ship their clicks anywhere — even the "page view".
  const DNT =
    (typeof navigator !== 'undefined') &&
    (navigator.doNotTrack === '1' ||
     navigator.doNotTrack === 'yes' ||
     window.doNotTrack === '1');

  // Early exit paths — keep the registered shim for call sites that
  // expect window.eneAnalytics to exist, but make .track() a no-op.
  function installNoopShim(reason) {
    if (!window.eneAnalytics) {
      window.eneAnalytics = {
        track: function () {},
        reason: reason,
      };
    } else if (typeof window.eneAnalytics.track !== 'function') {
      window.eneAnalytics.track = function () {};
    }
  }

  if (!PROVIDER || PROVIDER === 'none') return installNoopShim('not-configured');
  if (DNT) return installNoopShim('dnt');

  // ── Plausible loader ─────────────────────────────────────────────
  function loadPlausible() {
    if (!DOMAIN) {
      console.warn('[analytics] plausible: missing <meta name="ene-analytics-domain">');
      return;
    }
    if (document.querySelector('script[data-plausible]')) return;
    const s = document.createElement('script');
    s.defer = true;
    s.src = HOST.replace(/\/+$/, '') + '/js/script.js';
    s.setAttribute('data-domain', DOMAIN);
    s.setAttribute('data-plausible', '1');
    document.head.appendChild(s);

    // Expose plausible() shim before the script loads so early events
    // queue and fire on load (matches Plausible's recommended pattern).
    window.plausible = window.plausible || function () {
      (window.plausible.q = window.plausible.q || []).push(arguments);
    };
  }

  // ── gtag (GA4) loader ────────────────────────────────────────────
  function loadGtag() {
    if (!GA_ID) {
      console.warn('[analytics] gtag: missing <meta name="ene-analytics-id">');
      return;
    }
    if (document.querySelector('script[data-gtag]')) return;
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_ID);
    s.setAttribute('data-gtag', '1');
    document.head.appendChild(s);

    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    // anonymize_ip is deprecated in GA4 (IP anonymization is default) but
    // we still pass it to make the intent explicit in the config payload.
    window.gtag('config', GA_ID, { anonymize_ip: true });
  }

  // ── Provider bootstrap ───────────────────────────────────────────
  let forward = function () {}; // becomes the real forwarder once loaded

  if (PROVIDER === 'plausible') {
    loadPlausible();
    forward = function (event, props) {
      try { window.plausible && window.plausible(event, props ? { props: props } : undefined); }
      catch (_) {}
    };
  } else if (PROVIDER === 'gtag' || PROVIDER === 'ga4') {
    loadGtag();
    forward = function (event, props) {
      try { window.gtag && window.gtag('event', event, props || {}); }
      catch (_) {}
    };
  } else {
    console.warn('[analytics] unknown provider: ' + PROVIDER + ' — expected plausible | gtag | none');
    return installNoopShim('unknown-provider');
  }

  // ── Unified tracker exposed to page code ─────────────────────────
  const tracker = {
    provider: PROVIDER,
    track: function (event, props) {
      if (!event) return;
      forward(String(event), props || undefined);
    },
    // Kept so migration from the old inline tracker is silent.
    reason: 'configured',
  };
  window.eneAnalytics = tracker;

  // ── Listen for `ene:analytics` CustomEvents from any page ─────────
  window.addEventListener('ene:analytics', function (e) {
    const d = (e && e.detail) || {};
    if (!d.event) return;
    // Strip the internal plumbing fields before sending to the provider.
    const { event, ts, ...props } = d;
    tracker.track(event, props);
  });

  // ── Auto-track page view once ─────────────────────────────────────
  // Called after provider script is queued; Plausible/GA batch and send
  // when ready.
  (function pageView() {
    const p = (typeof location !== 'undefined') ? location.pathname + location.search : '/';
    if (PROVIDER === 'plausible') {
      // Plausible auto-pageview is fired by its own script; skip here.
    } else if (PROVIDER === 'gtag' || PROVIDER === 'ga4') {
      // GA4 auto-pageview is enabled by default from gtag config; skip.
    }
    // Intentionally doing nothing custom — both providers handle the
    // initial page view on their own. We only forward explicit events.
    void p;
  })();
})();
