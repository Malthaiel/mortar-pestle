// Shield scriptlet library — clean-room reimplementations of the uBlock Origin
// scriptlet *behaviours* Shield supports. This is NOT copied from uBlock's
// GPL `scriptlets.js`; each function is an original implementation of the
// documented effect, so it carries no upstream license obligation.
//
// Injected into every tab's MAIN world at document-start (see scriptlets.rs).
// `RULES` is prepended by the Rust host: an array of {d:[domains], s:name,
// a:[args]}. The dispatcher at the bottom runs only the scriptlets whose
// domains suffix-match the current hostname. Every call is wrapped in
// try/catch so one broken scriptlet can never break browsing.

var LIB = (function () {
  'use strict';

  // Parse a uBlock constant token into a JS value.
  function parseConst(raw) {
    switch (raw) {
      case 'undefined': return undefined;
      case 'false': return false;
      case 'true': return true;
      case 'null': return null;
      case 'noopFunc': return function () {};
      case 'trueFunc': return function () { return true; };
      case 'falseFunc': return function () { return false; };
      case 'emptyObj': return {};
      case 'emptyArr': return [];
      case "''": case '': return '';
    }
    if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
    if (/^-?\d*\.\d+$/.test(raw)) return parseFloat(raw);
    return raw;
  }

  // Build a matcher from a uBlock needle: /regex/flags -> RegExp test,
  // '' -> match-all, otherwise a substring test.
  function toMatcher(raw) {
    if (raw == null || raw === '') return function () { return true; };
    var s = String(raw);
    var m = /^\/(.+)\/([a-z]*)$/.exec(s);
    if (m) {
      try {
        var re = new RegExp(m[1], m[2]);
        return function (v) { return re.test(v); };
      } catch (e) { /* fall through */ }
    }
    return function (v) { return String(v).indexOf(s) !== -1; };
  }

  // Walk an object by a dot path with [] / [-] array wildcards, invoking
  // fn(parent, key) for each leaf match.
  function eachAtPath(root, parts, fn) {
    (function rec(obj, i) {
      if (obj == null || typeof obj !== 'object') return;
      var key = parts[i];
      var last = i === parts.length - 1;
      if (key === '[]' || key === '[-]') {
        if (!Array.isArray(obj)) return;
        for (var j = 0; j < obj.length; j++) {
          if (last) fn(obj, j); else rec(obj[j], i + 1);
        }
        return;
      }
      if (last) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) fn(obj, key);
        return;
      }
      rec(obj[key], i + 1);
    })(root, 0);
  }

  // Trailing tokens uBlock allows on a json-prune prop list that are flags,
  // not paths.
  var PRUNE_FLAGS = { important: 1, legacyImportant: 1, log: 1, '': 1 };

  function splitProps(raw) {
    return String(raw || '').split(/\s+/).filter(function (t) {
      return t && !PRUNE_FLAGS[t];
    });
  }

  function pruneJson(obj, pruneList, needList) {
    if (obj == null || typeof obj !== 'object') return obj;
    for (var n = 0; n < needList.length; n++) {
      var found = false;
      eachAtPath(obj, needList[n].split('.'), function () { found = true; });
      if (!found) return obj;          // required path absent -> prune nothing
    }
    for (var p = 0; p < pruneList.length; p++) {
      eachAtPath(obj, pruneList[p].split('.'), function (parent, key) {
        try {
          if (Array.isArray(parent)) parent.splice(key, 1);
          else delete parent[key];
        } catch (e) {}
      });
    }
    return obj;
  }

  // Cheap pre-check: only parse+prune a response body if a prune leaf name
  // actually appears in the raw text. Returns the pruned JSON string, or null
  // to leave the response untouched.
  function pruneResponseText(text, prune, need) {
    for (var i = 0; i < prune.length; i++) {
      var leaf = prune[i].split('.').pop();
      if (leaf && leaf !== '[]' && leaf !== '[-]' &&
          text.indexOf('"' + leaf + '"') !== -1) {
        return JSON.stringify(pruneJson(JSON.parse(text), prune, need));
      }
    }
    return null;
  }

  // Define a value/getter along a dot chain, trapping intermediate assignments
  // so the rule still applies when the chain is built lazily. Multiple rules
  // sharing an intermediate COMPOSE: a hidden per-object registry accumulates
  // child handlers, so a later assignment re-applies every rule's leaf. Without
  // this, a second set-constant on the same parent (e.g. YouTube's three
  // `ytInitialPlayerResponse.*` rules) would clobber the first.
  function defineChain(parts, makeLeaf) {
    function at(owner, i) {
      if (owner == null) return;
      var prop = parts[i];
      if (i === parts.length - 1) { makeLeaf(owner, prop); return; }
      var child = function (v) { at(v, i + 1); };
      var cur;
      try { cur = owner[prop]; } catch (e) { return; }
      if (cur && (typeof cur === 'object' || typeof cur === 'function')) { child(cur); return; }
      var reg = owner.__shieldReg__;
      if (!reg) {
        try {
          Object.defineProperty(owner, '__shieldReg__', { value: {}, configurable: true, enumerable: false });
          reg = owner.__shieldReg__;
        } catch (e) {}
      }
      if (reg && reg[prop]) { reg[prop].children.push(child); return; }
      var entry = { value: cur, children: [child] };
      if (reg) reg[prop] = entry;
      try {
        Object.defineProperty(owner, prop, {
          configurable: true,
          enumerable: true,
          get: function () { return entry.value; },
          set: function (v) {
            entry.value = v;
            if (v && (typeof v === 'object' || typeof v === 'function')) {
              for (var c = 0; c < entry.children.length; c++) entry.children[c](v);
            }
          }
        });
      } catch (e) {}
    }
    at(window, 0);
  }

  function magic() {
    return 'shield_' + Math.floor(Math.random() * 1e9).toString(36);
  }

  // ---- scriptlets ---------------------------------------------------------

  function setConstant(chain, rawVal) {
    var value = parseConst(rawVal);
    defineChain(chain.split('.'), function (owner, prop) {
      try {
        Object.defineProperty(owner, prop, {
          configurable: true,
          get: function () { return value; },
          set: function () {}
        });
      } catch (e) {}
    });
  }

  function abortOnPropertyRead(chain) {
    var tag = magic();
    defineChain(chain.split('.'), function (owner, prop) {
      try {
        Object.defineProperty(owner, prop, {
          configurable: true,
          get: function () { throw new ReferenceError(tag); },
          set: function () {}
        });
      } catch (e) {}
    });
  }

  function abortOnPropertyWrite(chain) {
    var tag = magic();
    defineChain(chain.split('.'), function (owner, prop) {
      try {
        Object.defineProperty(owner, prop, {
          configurable: true,
          set: function () { throw new ReferenceError(tag); }
        });
      } catch (e) {}
    });
  }

  function abortCurrentInlineScript(chain, needleRaw) {
    var matcher = toMatcher(needleRaw);
    var tag = magic();
    var parts = chain.split('.');
    var owner = window;
    for (var i = 0; i < parts.length - 1; i++) {
      if (owner == null) return;
      try { owner = owner[parts[i]]; } catch (e) { return; }
    }
    if (owner == null) return;
    var prop = parts[parts.length - 1];
    var current;
    try { current = owner[prop]; } catch (e) { return; }
    function check() {
      var s = document.currentScript;
      if (s && s.tagName === 'SCRIPT' && !s.src && matcher(s.textContent || '')) {
        throw new ReferenceError(tag);
      }
    }
    try {
      Object.defineProperty(owner, prop, {
        configurable: true,
        get: function () { check(); return current; },
        set: function (v) { check(); current = v; }
      });
    } catch (e) {}
  }

  function noWindowOpenIf(needleRaw) {
    var matcher = toMatcher(needleRaw);
    var orig = window.open;
    if (typeof orig !== 'function') return;
    window.open = function (url) {
      try { if (matcher(String(url == null ? '' : url))) return null; } catch (e) {}
      return orig.apply(this, arguments);
    };
  }

  function noFetchIf(needleRaw) {
    var matcher = toMatcher(needleRaw);
    var orig = window.fetch;
    if (typeof orig !== 'function') return;
    window.fetch = function (input) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (matcher(url)) return Promise.resolve(new Response('', { status: 200, statusText: 'OK' }));
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  }

  function noXhrIf(needleRaw) {
    var matcher = toMatcher(needleRaw);
    var X = window.XMLHttpRequest;
    if (typeof X !== 'function') return;
    var openOrig = X.prototype.open;
    var sendOrig = X.prototype.send;
    X.prototype.open = function (method, url) {
      this.__shieldBlock = false;
      try { if (matcher(String(url || ''))) this.__shieldBlock = true; } catch (e) {}
      return openOrig.apply(this, arguments);
    };
    X.prototype.send = function () {
      if (!this.__shieldBlock) return sendOrig.apply(this, arguments);
      var self = this;
      try {
        Object.defineProperty(self, 'readyState', { value: 4, configurable: true });
        Object.defineProperty(self, 'status', { value: 200, configurable: true });
        Object.defineProperty(self, 'responseText', { value: '', configurable: true });
        Object.defineProperty(self, 'response', { value: '', configurable: true });
      } catch (e) {}
      setTimeout(function () {
        try { if (typeof self.onreadystatechange === 'function') self.onreadystatechange(); } catch (e) {}
        try { self.dispatchEvent(new Event('readystatechange')); } catch (e) {}
        try { self.dispatchEvent(new Event('load')); } catch (e) {}
        try { self.dispatchEvent(new Event('loadend')); } catch (e) {}
      }, 1);
    };
  }

  function jsonPrune(rawPrune, rawNeed) {
    var prune = splitProps(rawPrune);
    var need = splitProps(rawNeed);
    if (!prune.length) return;
    var orig = JSON.parse;
    JSON.parse = function () {
      var r = orig.apply(this, arguments);
      try { return pruneJson(r, prune, need); } catch (e) { return r; }
    };
  }

  function jsonPruneFetchResponse(rawPrune, rawNeed) {
    var prune = splitProps(rawPrune);
    var need = splitProps(rawNeed);
    if (!prune.length) return;
    var orig = window.fetch;
    if (typeof orig !== 'function') return;
    window.fetch = function () {
      return orig.apply(this, arguments).then(function (resp) {
        try {
          var ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
          if (ct && ct.indexOf('json') === -1 && ct.indexOf('text') === -1) return resp;
          return resp.clone().text().then(function (text) {
            try {
              var out = pruneResponseText(text, prune, need);
              return out == null ? resp : new Response(out, {
                status: resp.status, statusText: resp.statusText, headers: resp.headers
              });
            } catch (e) { return resp; }
          }, function () { return resp; });
        } catch (e) { return resp; }
      });
    };
  }

  function jsonPruneXhrResponse(rawPrune, rawNeed) {
    var prune = splitProps(rawPrune);
    var need = splitProps(rawNeed);
    if (!prune.length) return;
    var X = window.XMLHttpRequest;
    if (typeof X !== 'function') return;
    var sendOrig = X.prototype.send;
    X.prototype.send = function () {
      var self = this;
      self.addEventListener('readystatechange', function () {
        if (self.readyState !== 4) return;
        try {
          var text = self.responseText;
          if (typeof text !== 'string' || !text) return;
          var out = pruneResponseText(text, prune, need);
          if (out == null) return;
          Object.defineProperty(self, 'responseText', { value: out, configurable: true });
          Object.defineProperty(self, 'response', { value: out, configurable: true });
        } catch (e) {}
      });
      return sendOrig.apply(this, arguments);
    };
  }

  return {
    setConstant: setConstant,
    abortOnPropertyRead: abortOnPropertyRead,
    abortOnPropertyWrite: abortOnPropertyWrite,
    abortCurrentInlineScript: abortCurrentInlineScript,
    noWindowOpenIf: noWindowOpenIf,
    noFetchIf: noFetchIf,
    noXhrIf: noXhrIf,
    jsonPrune: jsonPrune,
    jsonPruneFetchResponse: jsonPruneFetchResponse,
    jsonPruneXhrResponse: jsonPruneXhrResponse
  };
})();

// Suffix host match: rule domain `d` matches host `h` and all subdomains.
var __shieldHostMatches = function (h, domains) {
  for (var i = 0; i < domains.length; i++) {
    var d = domains[i];
    if (h === d || (h.length > d.length && h.slice(-(d.length + 1)) === '.' + d)) {
      return true;
    }
  }
  return false;
};

// Dispatcher — RULES is prepended by the Rust host.
(function () {
  var host = '';
  try { host = location.hostname || ''; } catch (e) { return; }
  if (typeof RULES === 'undefined' || !RULES) return;
  for (var k = 0; k < RULES.length; k++) {
    var rule = RULES[k];
    if (!rule || !__shieldHostMatches(host, rule.d)) continue;
    var fn = LIB[rule.s];
    if (typeof fn !== 'function') continue;
    try { fn.apply(null, rule.a || []); } catch (e) {}
  }
})();
