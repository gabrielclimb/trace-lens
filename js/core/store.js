(function (TV) {
  'use strict';

  const DERIVED = new Set(['model', 'journey']);
  const MODEL_INPUTS = ['parse', 'traceIndex', 'groupBy'];
  const FILTER_KEYS = new Set(['search', 'filters', 'selectedGroups', 'model']);

  function initialState() {
    return {
      parse: null, sourceName: '', traceIndex: 0,
      groupBy: 'service',
      model: null,
      journey: null,
      pathTargetId: null,
      selectedSpanId: null, hoverSpanId: null,
      selectedGroups: [],
      hoverGroup: null,
      search: '',
      filters: { categories: [], errorsOnly: false, minDuration: 0 },
      timeWindow: null,
      view: 'map',
      theme: 'auto',
      sidePanelOpen: true,
    };
  }

  function sameValue(a, b) {
    if (a === b) return true;
    if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }
    if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      const x = a[k], y = b[k];
      if (x === y) continue;
      if (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => v === y[i])) continue;
      return false;
    }
    return true;
  }

  function createStore() {
    let state = initialState();
    const listeners = new Set();
    const modelCache = new Map(); // `${traceIndex}|${groupBy}` → Model, for the current parse
    let cacheFor = null;
    let notifying = false;
    let pending = null;

    // filter caches (invalidated when search / filters / selectedGroups / model change)
    let matchCache = new WeakMap();
    let groupMatchCache = new Map();
    let searchCache = new WeakMap();

    function buildModelFor(s) {
      if (!s.parse || !s.parse.traces || !s.parse.traces.length) return null;
      if (cacheFor !== s.parse) { modelCache.clear(); cacheFor = s.parse; }
      const key = s.traceIndex + '|' + s.groupBy;
      if (!modelCache.has(key)) modelCache.set(key, TV.buildModel(s.parse.traces[s.traceIndex], { groupBy: s.groupBy }));
      return modelCache.get(key);
    }

    function journeyFor(model, targetId) {
      if (!model) return null;
      if (!targetId || !model.byId.has(targetId)) return model.journey;
      if (model.journey && model.journey.target && model.journey.target.id === targetId) return model.journey;
      return TV.computeJourney(model, targetId);
    }

    function notify(changed) {
      if (notifying) {
        if (!pending) pending = new Set();
        for (const k of changed) pending.add(k);
        return;
      }
      notifying = true;
      try {
        let batch = changed;
        while (batch) {
          for (const fn of Array.from(listeners)) {
            try { fn(state, batch); } catch (e) {
              if (typeof console !== 'undefined') console.error('[TV.store] subscriber failed:', e);
            }
          }
          batch = pending;
          pending = null;
        }
      } finally {
        notifying = false;
      }
    }

    function set(patch) {
      if (!patch || typeof patch !== 'object') return state;
      const prev = state;
      const next = Object.assign({}, state);
      const changed = new Set();
      for (const k of Object.keys(patch)) {
        if (DERIVED.has(k)) continue;
        if (!sameValue(prev[k], patch[k])) {
          next[k] = patch[k];
          changed.add(k);
        }
      }
      if (next.selectedGroups == null) next.selectedGroups = [];
      if (next.filters == null) next.filters = initialState().filters;

      if (MODEL_INPUTS.some((k) => changed.has(k))) {
        if (next.parse && next.parse.traces && (next.traceIndex < 0 || next.traceIndex >= next.parse.traces.length || !Number.isInteger(next.traceIndex))) {
          next.traceIndex = 0;
        }
        const model = buildModelFor(next);
        if (model !== prev.model) {
          next.model = model;
          changed.add('model');
          if (next.selectedSpanId && !(model && model.byId.has(next.selectedSpanId))) next.selectedSpanId = null;
          if (next.hoverSpanId && !(model && model.byId.has(next.hoverSpanId))) next.hoverSpanId = null;
          if (!('selectedGroups' in patch)) next.selectedGroups = [];
          if (!('hoverGroup' in patch)) next.hoverGroup = null;
          if (!('pathTargetId' in patch)) next.pathTargetId = null;
          if (!('timeWindow' in patch)) next.timeWindow = null;
          for (const k of ['selectedSpanId', 'hoverSpanId', 'selectedGroups', 'hoverGroup', 'pathTargetId', 'timeWindow']) {
            if (!sameValue(prev[k], next[k])) changed.add(k);
          }
        }
      }

      if (changed.has('model') || changed.has('pathTargetId')) {
        const j = journeyFor(next.model, next.pathTargetId);
        if (j !== prev.journey) {
          next.journey = j;
          changed.add('journey');
        }
      }

      if (!changed.size) return state;
      if ([...changed].some((k) => FILTER_KEYS.has(k))) {
        matchCache = new WeakMap();
        groupMatchCache = new Map();
      }
      if (changed.has('model')) searchCache = new WeakMap();
      state = next;
      notify(changed);
      return state;
    }

    function searchText(span) {
      let t = searchCache.get(span);
      if (t === undefined) {
        const parts = [span.id, span.name, span.group, span.service, span.op ? span.op.summary : ''];
        for (const k of Object.keys(span.attrs)) {
          const v = span.attrs[k];
          if (v == null) continue;
          parts.push(typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
        t = parts.join('\n').toLowerCase();
        searchCache.set(span, t);
      }
      return t;
    }

    function computeMatch(span) {
      const s = state;
      const f = s.filters || {};
      if (s.selectedGroups && s.selectedGroups.length && !s.selectedGroups.includes(span.group)) return false;
      if (f.categories && f.categories.length && !f.categories.includes(span.category)) return false;
      if (f.errorsOnly && !span.isError) return false;
      if (f.minDuration && !(span.duration >= f.minDuration)) return false;
      const q = (s.search || '').trim().toLowerCase();
      if (q && !searchText(span).includes(q)) return false;
      return true;
    }

    function matches(span) {
      if (!span) return false;
      let m = matchCache.get(span);
      if (m === undefined) {
        m = computeMatch(span);
        matchCache.set(span, m);
      }
      return m;
    }

    function groupMatches(groupKey) {
      if (groupMatchCache.has(groupKey)) return groupMatchCache.get(groupKey);
      const s = state;
      let ok = false;
      const g = s.model && s.model.groupByKey.get(groupKey);
      if (g && (!s.selectedGroups.length || s.selectedGroups.includes(groupKey))) ok = g.spans.some(matches);
      groupMatchCache.set(groupKey, ok);
      return ok;
    }

    function isFiltering() {
      const s = state;
      const f = s.filters || {};
      return !!((s.search || '').trim() || (f.categories && f.categories.length) || f.errorsOnly || f.minDuration ||
        (s.selectedGroups && s.selectedGroups.length));
    }

    function load(json, sourceName) {
      const parsed = TV.parse(json);
      set({ parse: parsed, sourceName: sourceName == null ? '' : String(sourceName), traceIndex: 0 });
      return state;
    }

    function subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    function reset() {
      const prev = state;
      state = initialState();
      modelCache.clear();
      cacheFor = null;
      matchCache = new WeakMap();
      groupMatchCache = new Map();
      searchCache = new WeakMap();
      const changed = new Set(Object.keys(state).filter((k) => !sameValue(prev[k], state[k])));
      if (changed.size) notify(changed);
    }

    return {
      get: () => state,
      set, subscribe, load, matches, groupMatches, isFiltering, reset,
      initialState,
    };
  }

  // ---------------------------------------------------------------- views registry

  const registry = new Map();
  const views = {
    register(def) {
      if (!def || !def.id || typeof def.mount !== 'function') throw new Error('TV.views.register: {id, mount} required');
      registry.set(def.id, Object.assign({ title: def.id, order: 100, slot: 'main' }, def));
      return registry.get(def.id);
    },
    list() {
      return Array.from(registry.values()).sort((a, b) => (a.order - b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    get(id) {
      return registry.get(id) || null;
    },
  };

  // ---------------------------------------------------------------- shared api builder

  // hooks: { showView(id), onSelectSpan(id, opts) } — shell and harness supply their own.
  function createApi(store, hooks) {
    hooks = hooks || {};
    const api = {
      store,
      util: TV.util,
      selectSpan(id, opts) {
        const patch = { selectedSpanId: id || null };
        if (id) patch.sidePanelOpen = true;
        store.set(patch);
        if (hooks.onSelectSpan) hooks.onSelectSpan(id || null, opts || {});
      },
      selectGroup(key, opts) {
        const cur = store.get().selectedGroups || [];
        let next;
        if (key == null) next = [];
        else if (opts && opts.additive) next = cur.includes(key) ? cur.filter((k) => k !== key) : cur.concat([key]);
        else next = cur.length === 1 && cur[0] === key ? [] : [key];
        store.set({ selectedGroups: next });
      },
      setPathTarget(spanId) {
        store.set({ pathTargetId: spanId || null });
        if (spanId) api.showView('journey');
      },
      showView(id) {
        if (hooks.showView) hooks.showView(id);
        else store.set({ view: id });
      },
    };
    return api;
  }

  TV.createStore = createStore;
  TV.store = createStore();
  TV.views = views;
  TV.createApi = createApi;
})(globalThis.TV = globalThis.TV || {});
