/**
 * Product Configurator — Tema Xtra (v2, autosufficiente)
 * Dati da #pc-product-data soltanto (nessun adapter / snippet esterni).
 */
(function () {
  'use strict';

  var PC_DEBUG = typeof window !== 'undefined' && window.location && /[?&]pc_debug(?:=|&|$)/.test(window.location.search || '');

  function dbg(tag, obj) {
    if (!PC_DEBUG) return;
    var t = String(tag || '').toUpperCase();
    try {
      if (obj !== undefined) console.log('[PC ' + t + ']', obj);
      else console.log('[PC ' + t + ']');
    } catch (e) {}
  }

  var CONFIG = {
    labels: {
      color: ['colore', 'color', 'colour'],
      size: ['taglia', 'size', 'misura'],
      print: ['personalizzazione', 'personalization', 'stampa', 'print'],
      quantity: ['quantità', 'quantita', 'quantity', 'qty', 'pezzi'],
      unavailable: 'Non disponibile',
      notAvailable: 'N/D'
    },
    quantityPricing: { enabled: false },
    deliveryNotes: [],
    pricingRules: { currency: null },
    /** Limite upload nativo Shopify (line item file property). */
    uploadMaxBytes: 20 * 1024 * 1024
  };

  function syncConfigFromProduct(product) {
    CONFIG.deliveryNotes = Array.isArray(product && product.deliveryNotes) ? product.deliveryNotes : [];
    dbg('DATA', {
      productId: product && product.id,
      quantityPricing: CONFIG.quantityPricing,
      personalization: (product && product.personalizationOptions && product.personalizationOptions.length) || 0
    });
  }

  function pcDbgQuantityPricing(msg, payload) {
    if (!PC_DEBUG) return;
    dbg('QTY', { msg: msg, payload: payload });
  }

  /** variant.price / compare_at_price Liquid: sempre minor units (centesimi). Mai moltiplicare per 100. */
  function centsFromShopifyVariantPrice(price) {
    if (price == null) return 0;
    var parsed = Number(String(price).replace(',', '.'));
    if (!Number.isFinite(parsed)) return 0;
    return Math.round(parsed);
  }

  /** Solo custom.config_base_pricing_json basePrice (o baseUnitPrice lì): valore in EURO → centesimi. */
  function centsFromMetafieldEuroPrice(price) {
    if (price == null) return 0;
    var parsed = Number(String(price).replace(',', '.'));
    if (!Number.isFinite(parsed)) return 0;
    return Math.round(parsed * 100);
  }

  function centsFromMetafieldEuroField(ev) {
    if (ev == null) return 0;
    if (typeof ev === 'object' && ev.amount != null) {
      return centsFromMetafieldEuroPrice(ev.amount);
    }
    return centsFromMetafieldEuroPrice(ev);
  }

  function isQuantityPricingActive() {
    return !!(CONFIG.quantityPricing && CONFIG.quantityPricing.enabled);
  }

  function normalizeDiscountTiersLocal(raw) {
    if (!raw || !Array.isArray(raw)) return [];
    return raw
      .map(function (row) {
        if (!row || typeof row !== 'object') return null;
        var minQ = parseInt(row.min != null ? row.min : row.minQty, 10);
        var disc = parseFloat(row.discount != null ? row.discount : row.discountPercent);
        if (isNaN(minQ) || minQ < 0) return null;
        if (isNaN(disc)) disc = 0;
        return { minQty: minQ, discountPercent: disc };
      })
      .filter(Boolean)
      .sort(function (a, b) {
        return a.minQty - b.minQty;
      });
  }

  /** Fallback se l'adapter non ha popolato CONFIG (stessi campi metafield, nessun valore hardcoded). */
  function hydrateQuantityPricingFromProduct() {
    if (isQuantityPricingActive()) return;
    var p = state.product;
    if (!p || p.quantityPricing == null) return;
    var raw = p.quantityPricing;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch (e) {
        return;
      }
    }
    if (!raw || typeof raw !== 'object') return;
    var hasBase = raw.basePrice !== undefined && raw.basePrice !== null;
    var hasUnit = raw.baseUnitPrice !== undefined && raw.baseUnitPrice !== null;
    if (!hasBase && !hasUnit) return;
    var ev = hasBase ? raw.basePrice : raw.baseUnitPrice;
    var basePriceCents = centsFromMetafieldEuroField(ev);
    if (basePriceCents <= 0) return;
    var minQty = Math.max(1, parseInt(raw.minQty, 10) || 1);
    var qtyStep = Math.max(1, parseInt(raw.qtyStep, 10) || 1);
    CONFIG.quantityPricing = {
      enabled: true,
      basePriceCents: basePriceCents,
      minQty: minQty,
      qtyStep: qtyStep,
      vatIncluded: raw.vatIncluded === true || raw.vatIncluded === 'true',
      tiers: normalizeDiscountTiersLocal(raw.discountTiers)
    };
    pcDbgQuantityPricing('hydrateQuantityPricingFromProduct', {
      basePriceRaw: ev,
      basePriceCents: basePriceCents
    });
  }

  function resolveDiscountPercentFromTiers(totalQty, tiers) {
    if (!tiers || !tiers.length) return 0;
    var tq = parseInt(totalQty, 10);
    if (isNaN(tq) || tq < 0) return 0;
    var sorted = tiers.slice().sort(function (a, b) {
      return b.minQty - a.minQty;
    });
    for (var i = 0; i < sorted.length; i++) {
      if (tq >= sorted[i].minQty) {
        var d = sorted[i].discountPercent;
        return typeof d === 'number' && !isNaN(d) ? d : parseFloat(d) || 0;
      }
    }
    return 0;
  }

  /**
   * Prezzo unitario dopo sconto, come lo applica Shopify in checkout:
   * lo sconto per pezzo è troncato al centesimo (floor), poi moltiplicato per la quantità.
   */
  function shopifyNetUnitCents(baseCents, discPercent) {
    var base = Math.round(Number(baseCents) || 0);
    var disc = Number(discPercent) || 0;
    if (base <= 0) return 0;
    if (disc <= 0) return base;
    var off = Math.floor((base * disc) / 100);
    return Math.max(0, base - off);
  }

  /** Totale merce (centesimi) allineato al carrello. */
  function getQuantityPricingMerchandiseTotalCents() {
    if (!isQuantityPricingActive()) return 0;
    var tq = getTotalQuantity();
    if (tq <= 0) return 0;
    var qp = CONFIG.quantityPricing;
    var disc = resolveDiscountPercentFromTiers(tq, qp.tiers);
    return shopifyNetUnitCents(qp.basePriceCents, disc) * tq;
  }

  /** Riparto proporzionale del totale merce per riga matrice (somma righe = totale merce). */
  function getQuantityPricingLineMerchCentsMap() {
    var map = {};
    if (!isQuantityPricingActive()) return map;
    var merch = getQuantityPricingMerchandiseTotalCents();
    var tq = getTotalQuantity();
    if (tq <= 0) return map;
    var vids = Object.keys(state.quantities).filter(function (vid) {
      return (state.quantities[vid] || 0) > 0;
    });
    vids.sort();
    var allocated = 0;
    for (var i = 0; i < vids.length; i++) {
      var vid = vids[i];
      var q = state.quantities[vid] || 0;
      if (i === vids.length - 1) map[vid] = merch - allocated;
      else {
        var part = Math.round((merch * q) / tq);
        map[vid] = part;
        allocated += part;
      }
    }
    if (PC_DEBUG) {
      dbg('QTY', { merchandiseTotalCents: merch, totalQty: tq, map: map });
    }
    return map;
  }

  function getQuantityPricingSnapshot() {
    if (!isQuantityPricingActive()) return null;
    var qp = CONFIG.quantityPricing;
    var total = getTotalQuantity();
    if (total <= 0) return null;
    var disc = resolveDiscountPercentFromTiers(total, qp.tiers);
    var baseCents = qp.basePriceCents;
    var netUnitCents = shopifyNetUnitCents(baseCents, disc);
    var merchandiseCents = netUnitCents * total;
    if (isNaN(merchandiseCents) || merchandiseCents < 0) merchandiseCents = 0;
    pcDbgQuantityPricing('getQuantityPricingSnapshot', {
      basePriceCents: baseCents,
      quantity: total,
      discount: disc,
      unitPriceCents: netUnitCents,
      merchandiseTotalCents: merchandiseCents
    });
    return {
      qty: total,
      baseUnitCents: baseCents,
      discountPercent: disc,
      merchandiseCents: merchandiseCents,
      netUnitCents: netUnitCents
    };
  }

  /**
   * Abbigliamento: min/step sul TOTALE (taglie/colori misti liberi).
   * Gadget: min/step per singola variante/colore (confezione).
   */
  function snapOrderQuantityToMinStep(opts) {
    opts = opts || {};
    var notify = opts.notify !== false;
    var qp = CONFIG.quantityPricing;
    if (!qp || !qp.enabled) return false;
    var minQ = qp.minQty;
    var step = qp.qtyStep;
    var vid = state.lastQtyVariantId;
    if (!vid || state.quantities[vid] == null) {
      var keys = Object.keys(state.quantities).filter(function (k) {
        return (state.quantities[k] || 0) > 0;
      });
      vid = keys.length ? keys[keys.length - 1] : Object.keys(state.quantities)[0];
    }
    if (!vid) return false;

    if (isApparelQuantityMode()) {
      var tApparel = getTotalQuantity();
      if (tApparel <= 0) return false;
      /* Sotto il minimo: non toccare — si può ancora distribuire tra taglie/colori */
      if (tApparel < minQ) return false;
      var remA = (tApparel - minQ) % step;
      if (remA === 0) return false;
      var targetA = tApparel - remA;
      var toastA =
        "Il valore dev'essere inferiore o uguale a " +
        targetA +
        '. Prodotto ordinabile solo in multipli da ' +
        step;
      if (targetA === tApparel) return false;
      var curA = state.quantities[vid] || 0;
      state.quantities[vid] = Math.max(0, curA + (targetA - tApparel));
      syncMatrixInputs();
      if (typeof updateSummary === 'function') updateSummary();
      if (typeof updateNavButtons === 'function') updateNavButtons();
      if (notify && toastA) showQuickErrorToast(toastA, vid);
      return true;
    }

    /* Gadget: allinea la singola variante (confezione per colore) */
    var cur = state.quantities[vid] || 0;
    if (cur <= 0) return false;
    var target;
    var toastMsg;
    if (cur < minQ) {
      target = minQ;
      toastMsg =
        'Quantità minima ' + minQ + ' pezzi per colore/variante. Ordinabile solo in multipli da ' + step;
    } else {
      var rem = (cur - minQ) % step;
      if (rem === 0) return false;
      target = cur - rem;
      toastMsg =
        "Il valore dev'essere inferiore o uguale a " +
        target +
        '. Ordinabile solo in multipli da ' +
        step +
        ' per colore/variante';
    }
    if (target === cur) return false;
    state.quantities[vid] = Math.max(0, target);
    syncMatrixInputs();
    if (typeof updateSummary === 'function') updateSummary();
    if (typeof updateNavButtons === 'function') updateNavButtons();
    if (notify && toastMsg) showQuickErrorToast(toastMsg, vid);
    return true;
  }

  var _quickToastTimer = null;
  function findQtyInputAnchor(variantId) {
    var nodes = [];
    if (variantId) {
      nodes = document.querySelectorAll('.pc-matrix-qty-input[data-variant-id="' + String(variantId) + '"]');
    }
    if (!nodes.length) nodes = document.querySelectorAll('.pc-matrix-qty-input');
    var visible = null;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        visible = n;
        /* Preferisci l'input nella vista attiva (mobile vs desktop) */
        var isMobileInp = n.classList.contains('pc-matrix-mobile-qty-input');
        var isMobileView = window.matchMedia('(max-width: 767px)').matches;
        if (isMobileInp === isMobileView) return n;
      }
    }
    return visible;
  }

  function showQuickErrorToast(text, variantId) {
    var overlay = document.getElementById('pc-modal-overlay');
    var host = overlay || document.body;
    var el = document.getElementById('pc-quick-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pc-quick-toast';
      el.setAttribute('role', 'alert');
      el.setAttribute('aria-live', 'assertive');
      host.appendChild(el);
    } else if (el.parentNode !== host) {
      host.appendChild(el);
    }
    el.className = 'pc-quick-toast pc-quick-toast-visible';
    el.textContent = text;

    var base = [
      'position:absolute',
      'z-index:100',
      'max-width:min(92%, 420px)',
      'padding:14px 18px',
      'border-radius:12px',
      'background:#F4602B',
      'color:#fff',
      'font-size:1.2rem',
      'font-weight:700',
      'line-height:1.35',
      'text-align:center',
      'box-shadow:0 12px 28px rgba(244,96,43,0.35)',
      'opacity:1',
      'pointer-events:none',
      'display:block',
      'visibility:visible',
      'white-space:normal'
    ];

    var anchor = findQtyInputAnchor(variantId || state.lastQtyVariantId);
    if (anchor && overlay) {
      var ar = anchor.getBoundingClientRect();
      var or = overlay.getBoundingClientRect();
      var left = ar.left - or.left + overlay.scrollLeft + ar.width / 2;
      var top = ar.top - or.top + overlay.scrollTop - 10;
      base.push('left:' + Math.round(left) + 'px');
      base.push('top:' + Math.round(top) + 'px');
      base.push('transform:translate(-50%,-100%)');
    } else {
      base.push('left:50%');
      base.push('top:20%');
      base.push('transform:translateX(-50%)');
    }
    el.style.cssText = base.join(';');

    if (_quickToastTimer) clearTimeout(_quickToastTimer);
    _quickToastTimer = setTimeout(function () {
      el.style.opacity = '0';
      el.style.visibility = 'hidden';
      el.classList.remove('pc-quick-toast-visible');
    }, 2800);
  }

  function updateQtyPricingHint() {
    var el = document.getElementById('pc-qty-pricing-hint');
    if (!el) return;
    if (!isQuantityPricingActive()) {
      el.classList.add('pc-hidden');
      el.textContent = '';
      return;
    }
    var qp = CONFIG.quantityPricing;
    if (isApparelQuantityMode()) {
      el.textContent =
        'Quantità minima totale: ' +
        qp.minQty +
        ' pezzi (somma di tutte le taglie/colori). Puoi suddividere liberamente. Step ordine: ' +
        qp.qtyStep +
        '.';
    } else {
      el.textContent =
        'Quantità minima: ' +
        qp.minQty +
        ' pezzi per colore/variante — Step: ' +
        qp.qtyStep +
        ' (confezione).';
    }
    el.classList.remove('pc-hidden');
  }

  function hideConfiguratorWhenNotConfigurable() {
    var cta = document.getElementById('pc-cta-area');
    if (cta) cta.classList.add('pc-hidden');
    var ov = document.getElementById('pc-modal-overlay');
    if (ov) ov.classList.add('pc-hidden');
  }

  /** Messaggio QP se attivo e quantità non valida; null se OK o QP disattivo / qtà 0. */
  function getQuantityPricingValidationMessage() {
    if (!isQuantityPricingActive()) return null;
    var t = getTotalQuantity();
    if (t <= 0) return null;
    var qp = CONFIG.quantityPricing;
    if (isApparelQuantityMode()) {
      if (t < qp.minQty) {
        return (
          'La quantità totale deve essere almeno ' +
          qp.minQty +
          ' pezzi (somma di tutte le taglie/colori). Ora: ' +
          t +
          '.'
        );
      }
      if ((t - qp.minQty) % qp.qtyStep !== 0) {
        return (
          "Il valore dev'essere inferiore o uguale a " +
          (t - ((t - qp.minQty) % qp.qtyStep)) +
          '. Prodotto ordinabile solo in multipli da ' +
          qp.qtyStep
        );
      }
      return null;
    }
    /* Gadget: ogni colore/variante con qty > 0 deve rispettare confezione */
    var vids = Object.keys(state.quantities);
    for (var i = 0; i < vids.length; i++) {
      var q = state.quantities[vids[i]] || 0;
      if (q <= 0) continue;
      if (q < qp.minQty) {
        return (
          'Ogni colore/variante deve essere almeno ' +
          qp.minQty +
          ' pezzi (confezione). Non è possibile suddividere il minimo su più colori.'
        );
      }
      if ((q - qp.minQty) % qp.qtyStep !== 0) {
        return (
          'Ogni colore/variante è ordinabile solo in multipli da ' +
          qp.qtyStep +
          ' pezzi (confezione).'
        );
      }
    }
    return null;
  }

  function validateQuantityPricingRules() {
    var msg = getQuantityPricingValidationMessage();
    if (msg) {
      showMessage(msg, 'error');
      return false;
    }
    return true;
  }

  var state = {
    product: null,
    variantMap: {},
    colorAxis: null,
    sizeAxis: null,
    printAxis: null,
    quantities: {},
    currentStep: 1,
    totalSteps: 4,
    personalizationGeneral: {},
    personalizationApparel: {},
    /** Premiazioni: testo etichette 1..10 (solo valori non vuoti vanno in carrello). */
    awardsLabels: {},
    awardsVisibleCount: 6,
    files: [],
    sendLater: false,
    lastQtyVariantId: null
  };

  var AWARDS_LABEL_MAX_LEN = 50;
  var AWARDS_LABEL_MAX_COUNT = 10;
  var AWARDS_LABEL_INITIAL_VISIBLE = 6;
  var AWARDS_LABEL_DEFS = [
    { index: 1, key: 'targhetta_1', label: 'Targhetta 1° Posto 🥇' },
    { index: 2, key: 'targhetta_2', label: 'Targhetta 2° Posto 🥈' },
    { index: 3, key: 'targhetta_3', label: 'Targhetta 3° Posto 🥉' },
    { index: 4, key: 'targhetta_4', label: 'Targhetta 4' },
    { index: 5, key: 'targhetta_5', label: 'Targhetta 5' },
    { index: 6, key: 'targhetta_6', label: 'Targhetta 6' },
    { index: 7, key: 'targhetta_7', label: 'Targhetta 7' },
    { index: 8, key: 'targhetta_8', label: 'Targhetta 8' },
    { index: 9, key: 'targhetta_9', label: 'Targhetta 9' },
    { index: 10, key: 'targhetta_10', label: 'Targhetta 10' }
  ];

  /**
   * Formatta centesimi in euro per la UI. Usa sempre questa funzione per mostrare prezzi.
   * Input: centesimi (number). Output: stringa "7,90 €".
   */
  function formatMoneyFromCents(cents) {
    var c = Number(cents);
    if (isNaN(c) || c < 0) c = 0;
    return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(c / 100);
  }

  function formatMoney(cents) {
    if (!CONFIG || !CONFIG.pricingRules) return formatMoneyFromCents(0);
    return formatMoneyFromCents(cents);
  }

  /** Prezzo/unità medio da totale merce arrotondato (sconto sul totale), per UI e proprietà carrello. */
  function formatEuroUnitAverage(merchCents, qty) {
    var q = parseInt(qty, 10);
    if (!isFinite(merchCents) || merchCents < 0 || isNaN(q) || q <= 0) return formatMoney(0);
    var euro = merchCents / q / 100;
    return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(euro);
  }

  function parsePrice(val) {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      var n = parseFloat(val.replace(/[^\d.,]/g, '').replace(',', '.'));
      return isNaN(n) ? 0 : Math.round(n * 100);
    }
    return 0;
  }

  function showMessage(text, type) {
    var el = document.getElementById('pc-messages');
    if (!el) return;
    el.textContent = text;
    el.className = 'pc-messages' + (type ? ' pc-' + type : '');
    el.setAttribute('role', 'alert');
  }

  function clearMessage() {
    var el = document.getElementById('pc-messages');
    if (el) { el.textContent = ''; el.className = 'pc-messages'; }
  }

  function getProductJson() {
    var script = document.getElementById('pc-product-data');
    if (!script || !script.textContent) return null;
    try { return JSON.parse(script.textContent); } catch (e) { return null; }
  }

  function escapeHtml(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function escapeHtmlAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function sanitizePersonalizationOptionsList(raw) {
    var out = [];
    if (!raw || !Array.isArray(raw)) return out;
    raw.forEach(function (entry) {
      if (!entry || typeof entry !== 'object') return;
      var pct = Number(entry.percentage);
      if (!isFinite(pct) || pct < 0) return;
      var key = String(entry.key || '').trim();
      if (!key) return;
      var label = String(entry.label || key).trim() || key;
      var desc = entry.description != null ? String(entry.description).trim() : '';
      out.push({ key: key, label: label, percentage: pct, description: desc });
    });
    return out;
  }

  function sanitizePersonalizationMeta(raw) {
    var out = { mode: 'general', minimumOrderQuantity: null };
    if (!raw || typeof raw !== 'object') return out;
    var m = String(raw.mode || 'general').toLowerCase().trim();
    if (m === 'awards' || m === 'premiazioni' || m.indexOf('premiaz') >= 0 || m.indexOf('award') >= 0) {
      out.mode = 'awards';
    } else if (m === 'clothing' || m === 'abbigliamento' || m.indexOf('clothing') >= 0 || m.indexOf('abbigliamento') >= 0) {
      out.mode = 'clothing';
    } else {
      out.mode = 'general';
    }
    if (raw.minimumOrderQuantity != null && String(raw.minimumOrderQuantity).trim() !== '') {
      var mo = parseInt(String(raw.minimumOrderQuantity).replace(/\s/g, ''), 10);
      if (isFinite(mo) && mo > 0) out.minimumOrderQuantity = mo;
    }
    return out;
  }

  function usesMetaPersonalization() {
    if (isAwardsPersMode()) return false;
    var list = state.product && state.product.personalizationOptions;
    return Array.isArray(list) && list.length > 0;
  }

  function isClothingPersMode() {
    var meta = state.product && state.product.personalizationMeta;
    return meta && meta.mode === 'clothing';
  }

  function isAwardsPersMode() {
    var meta = state.product && state.product.personalizationMeta;
    if (meta && meta.mode === 'awards') return true;
    var product = state.product;
    if (!product) return false;
    if (product.inPremiazioniCollection === true) return true;
    var t = String(product.productType || product.type || '')
      .toLowerCase()
      .trim();
    return t.indexOf('premiaz') >= 0;
  }

  function getAwardsLabelDef(index) {
    for (var i = 0; i < AWARDS_LABEL_DEFS.length; i++) {
      if (AWARDS_LABEL_DEFS[i].index === index) return AWARDS_LABEL_DEFS[i];
    }
    return null;
  }

  function getFilledAwardsLabels() {
    var out = [];
    AWARDS_LABEL_DEFS.forEach(function (def) {
      var raw = state.awardsLabels[def.index];
      var text = raw == null ? '' : String(raw).trim();
      if (!text) return;
      if (text.length > AWARDS_LABEL_MAX_LEN) text = text.substring(0, AWARDS_LABEL_MAX_LEN);
      out.push({ index: def.index, key: def.key, label: def.label, text: text });
    });
    return out;
  }

  function countFilledAwardsLabels() {
    return getFilledAwardsLabels().length;
  }

  /** True se il prodotto è abbigliamento: quantità miste su totale; altrimenti regole per variante (gadget). */
  function isApparelQuantityMode() {
    if (isClothingPersMode()) return true;
    var t = '';
    if (CONFIG && CONFIG.configProductType) t = CONFIG.configProductType;
    else if (state.product && state.product.configProductType) t = state.product.configProductType;
    t = String(t || '')
      .toLowerCase()
      .trim();
    if (!t) return false;
    return (
      t === 'clothing' ||
      t === 'abbigliamento' ||
      t.indexOf('clothing') >= 0 ||
      t.indexOf('abbigliamento') >= 0
    );
  }

  /** Coppie non combinabili nello step 2 (match su key o label normalizzate). */
  var PERSONALIZATION_EXCLUSIVE_GROUPS = [
    ['stampa_1_lato', 'stampa_2_lati'],
    /* stampa_monocolore = alias legacy di "Stampa 1 colore" */
    ['stampa_1_colore', 'stampa_monocolore', 'etichetta_adesiva_a_colori', 'stampa_colori', 'stampa_a_colori']
  ];

  var PRINT_TOKEN_ALIASES = [
    ['stampa_colori', 'stampa_a_colori', 'stampa_digitale_a_colori'],
    ['stampa_1_colore', 'stampa_monocolore']
  ];

  function normalizePersToken(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function getPersOptionTokens(opt) {
    if (!opt) return [];
    var tokens = [];
    var keyTok = normalizePersToken(opt.key);
    var labelTok = normalizePersToken(opt.label);
    if (keyTok) tokens.push(keyTok);
    if (labelTok && tokens.indexOf(labelTok) < 0) tokens.push(labelTok);
    return tokens;
  }

  function persTokensIntersect(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (b.indexOf(a[i]) >= 0) return true;
    }
    return false;
  }

  function getExclusiveConflictKeys(selectedOpt, list) {
    var selectedTokens = getPersOptionTokens(selectedOpt);
    if (!selectedTokens.length) return [];
    var peerTokens = [];
    PERSONALIZATION_EXCLUSIVE_GROUPS.forEach(function (group) {
      var normGroup = group.map(normalizePersToken);
      if (!persTokensIntersect(selectedTokens, normGroup)) return;
      normGroup.forEach(function (tok) {
        if (selectedTokens.indexOf(tok) < 0 && peerTokens.indexOf(tok) < 0) {
          peerTokens.push(tok);
        }
      });
    });
    if (!peerTokens.length) return [];
    var conflicts = [];
    (list || []).forEach(function (opt) {
      if (!opt || opt.key === selectedOpt.key) return;
      if (persTokensIntersect(getPersOptionTokens(opt), peerTokens)) {
        conflicts.push(opt.key);
      }
    });
    return conflicts;
  }

  function hasSelectedGeneralPersonalization() {
    var g = state.personalizationGeneral || {};
    return Object.keys(g).some(function (k) {
      return !!g[k];
    });
  }

  function getPersonalizationSelectionMap() {
    return isClothingPersMode() ? state.personalizationApparel : state.personalizationGeneral;
  }

  function expandPersTokens(tokens) {
    var out = (tokens || []).slice();
    PRINT_TOKEN_ALIASES.forEach(function (group) {
      var hit = false;
      for (var i = 0; i < out.length; i++) {
        if (group.indexOf(out[i]) >= 0) {
          hit = true;
          break;
        }
      }
      if (!hit) return;
      group.forEach(function (tok) {
        if (out.indexOf(tok) < 0) out.push(tok);
      });
    });
    return out;
  }

  function compactPersToken(value) {
    return normalizePersToken(value).replace(/_a_/g, '_').replace(/__+/g, '_');
  }

  function optionNameMatches(name, keys) {
    var n = String(name || '').toLowerCase();
    if (!n) return false;
    for (var i = 0; i < keys.length; i++) {
      if (n.indexOf(keys[i]) !== -1) return true;
    }
    return false;
  }

  function getCanonicalPrintValue() {
    if (!state.printAxis || !state.printAxis.values || !state.printAxis.values.length) return null;
    return state.printAxis.values[0];
  }

  function variantOptionAt(variant, index) {
    if (!variant) return null;
    if (index === 0) return variant.option1;
    if (index === 1) return variant.option2;
    if (index === 2) return variant.option3;
    return null;
  }

  function withVariantOption(variant, index, value) {
    if (!variant) return null;
    var opts = [variant.option1, variant.option2, variant.option3];
    opts[index] = value;
    return getVariantForOptions(opts[0], opts[1], opts[2]);
  }

  function matchPrintAxisValueForOption(opt) {
    if (!opt || !state.printAxis || !state.printAxis.values) return null;
    var optTokens = expandPersTokens(getPersOptionTokens(opt)).map(compactPersToken);
    var values = state.printAxis.values;
    for (var i = 0; i < values.length; i++) {
      var valueTokens = expandPersTokens([normalizePersToken(values[i])]).map(compactPersToken);
      if (persTokensIntersect(optTokens, valueTokens)) return values[i];
    }
    return null;
  }

  function getSelectedPrintAxisValue() {
    if (!state.printAxis) return null;
    var selected = getPersonalizationSelectionMap() || {};
    var list = (state.product && state.product.personalizationOptions) || [];
    for (var i = 0; i < list.length; i++) {
      var opt = list[i];
      if (!opt || !selected[opt.key]) continue;
      var matched = matchPrintAxisValueForOption(opt);
      if (matched) return matched;
    }
    return null;
  }

  function resolveCartVariant(matrixVariant) {
    if (!matrixVariant) return null;
    var printVal = getSelectedPrintAxisValue();
    if (!printVal || !state.printAxis) return matrixVariant;
    if (variantOptionAt(matrixVariant, state.printAxis.index) === printVal) return matrixVariant;
    return withVariantOption(matrixVariant, state.printAxis.index, printVal) || matrixVariant;
  }

  function calculatePrintAxisDeltaCents() {
    var printVal = getSelectedPrintAxisValue();
    if (!printVal || !state.printAxis) return 0;
    var product = state.product;
    if (!product || !product.variants || !Array.isArray(product.variants)) return 0;
    var delta = 0;
    Object.keys(state.quantities).forEach(function (vid) {
      var q = state.quantities[vid] || 0;
      if (q <= 0) return;
      var matrixV = product.variants.find(function (x) { return String(x.id) === vid; });
      if (!matrixV) return;
      var cartV = resolveCartVariant(matrixV);
      if (!cartV || String(cartV.id) === String(matrixV.id)) return;
      delta += (variantPriceCents(cartV) - variantPriceCents(matrixV)) * q;
    });
    return Math.max(0, Math.round(delta));
  }

  function getUncoveredPersonalizationSurchargeCents() {
    return getPersonalizationLineDetails().reduce(function (sum, d) {
      if (!d || d.coveredByVariant) return sum;
      return sum + (d.cents || 0);
    }, 0);
  }

  function getSurchargeVariantId() {
    var product = state.product;
    var raw = product && product.surchargeVariantId;
    if (raw == null || raw === '') {
      var wrap = document.getElementById('pc-configurator');
      if (wrap && wrap.dataset.surchargeVariantId) raw = wrap.dataset.surchargeVariantId;
    }
    return toNumericVariantId(raw);
  }

  function getMatrixVariant(color, size) {
    var ov = [];
    if (state.colorAxis && color != null && color !== '') ov[state.colorAxis.index] = color;
    if (state.sizeAxis && size != null && size !== '') ov[state.sizeAxis.index] = size;
    if (state.printAxis) {
      var pv = getCanonicalPrintValue();
      if (pv != null) ov[state.printAxis.index] = pv;
    }
    return getVariantForOptions(ov[0], ov[1], ov[2]);
  }

  function getPersonalizationLineDetails() {
    var out = [];
    if (!usesMetaPersonalization()) return out;
    var list = state.product.personalizationOptions;
    var selected = getPersonalizationSelectionMap() || {};
    var printVal = getSelectedPrintAxisValue();
    var printDelta = calculatePrintAxisDeltaCents();
    var printDeltaAssigned = false;
    var remappedMerch = calculateBaseItemsTotal() + printDelta;
    (list || []).forEach(function (opt) {
      if (!selected[opt.key]) return;
      var matchedPrint = matchPrintAxisValueForOption(opt);
      if (matchedPrint && printVal && matchedPrint === printVal && !printDeltaAssigned) {
        var remapApplied = printDelta > 0 || matchedPrint === getCanonicalPrintValue();
        if (remapApplied) {
          printDeltaAssigned = true;
          out.push({
            key: opt.key,
            label: opt.label,
            percentage: Number(opt.percentage) || 0,
            cents: printDelta,
            coveredByVariant: true
          });
          return;
        }
      }
      var pct = Number(opt.percentage);
      if (!isFinite(pct)) return;
      out.push({
        key: opt.key,
        label: opt.label,
        percentage: pct,
        cents: Math.round((remappedMerch * pct) / 100),
        coveredByVariant: false
      });
    });
    return out;
  }

  function calculateMetaPersonalizationSurchargeCents() {
    var details = getPersonalizationLineDetails();
    return details.reduce(function (sum, d) {
      return sum + d.cents;
    }, 0);
  }

  function step1ApparelMinOrderBlockReason() {
    var meta = state.product && state.product.personalizationMeta;
    if (!meta || !isClothingPersMode() || meta.minimumOrderQuantity == null || meta.minimumOrderQuantity <= 0) {
      return null;
    }
    var tq = getTotalQuantity();
    if (tq <= 0) return null;
    if (tq < meta.minimumOrderQuantity) {
      return (
        'La quantità totale deve essere almeno ' +
        meta.minimumOrderQuantity +
        ' pezzi (minimo ordine personalizzazione).'
      );
    }
    return null;
  }

  function refreshMetaPersCardPrices() {
    var box = document.getElementById('pc-personalization-meta');
    if (!box || !usesMetaPersonalization()) return;
    var base = calculateBaseItemsTotal();
    var cards = box.querySelectorAll('.pc-pers-card[data-pers-pct]');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var pct = parseFloat(card.getAttribute('data-pers-pct'), 10);
      if (!isFinite(pct)) continue;
      var cents = Math.round((base * pct) / 100);
      var el = card.querySelector('.pc-pers-card-price');
      if (el) {
        if (pct <= 0) el.textContent = 'Incluso';
        else el.textContent = '+' + formatMoney(cents);
      }
    }
  }

  function syncMetaPersCardSelectedState() {
    var box = document.getElementById('pc-personalization-meta');
    if (!box) return;
    var cards = box.querySelectorAll('.pc-pers-card');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var inp = card.querySelector('.pc-pers-card-input');
      if (!inp) continue;
      card.classList.toggle('pc-pers-card--selected', !!inp.checked);
    }
  }

  function applyAwardsStepChrome() {
    var awards = isAwardsPersMode();
    document.documentElement.classList.toggle('pc-awards-mode', awards);
    var tab2 = document.querySelector('.pc-step-tab[data-step="2"] .pc-step-label');
    var tab3 = document.querySelector('.pc-step-tab[data-step="3"] .pc-step-label');
    if (tab2) tab2.textContent = awards ? 'Etichette' : 'Personalizzazione';
    if (tab3) tab3.textContent = awards ? 'Logo e note' : 'File e note';
    var title2 = document.getElementById('pc-step-2-title');
    var title3 = document.getElementById('pc-step-3-title');
    if (title2) {
      title2.innerHTML = awards
        ? 'Etichette <span class="pc-step-index">2/4</span>'
        : 'Personalizzazione <span class="pc-step-index">2/4</span>';
    }
    if (title3) {
      title3.innerHTML = awards
        ? 'Logo e note <span class="pc-step-index">3/4</span>'
        : 'File e note <span class="pc-step-index">3/4</span>';
    }
    MOBILE_STEP_TITLES = mergeMobileStepTitles(
      awards ? { 2: 'Etichette', 3: 'Logo e note' } : null
    );
    var sendLaterWrap = document.getElementById('pc-send-later-wrap');
    var sendLater = document.getElementById('pc-send-later');
    if (sendLaterWrap) sendLaterWrap.hidden = !!awards;
    if (awards && sendLater) {
      sendLater.checked = false;
      state.sendLater = false;
    }
    var phText = document.getElementById('pc-upload-placeholder-text');
    if (phText) {
      phText.textContent = awards
        ? 'Carica logo (opzionale) — trascina o clicca'
        : 'Trascina i file qui o clicca per selezionare';
    }
    var fileInput = document.getElementById('pc-file-input');
    if (fileInput) {
      fileInput.setAttribute(
        'aria-label',
        awards ? 'Carica logo (opzionale)' : 'Carica file grafici'
      );
    }
    var nextBtn = document.getElementById('pc-btn-next');
    if (nextBtn && state.currentStep <= 1) {
      nextBtn.textContent = awards ? 'Passa alle Etichette' : 'Passa alla Personalizzazione';
      nextBtn.setAttribute(
        'aria-label',
        awards ? 'Passa alle Etichette' : 'Passa alla Personalizzazione'
      );
    }
  }

  function syncAwardsLabelVisibility() {
    var box = document.getElementById('pc-awards-labels');
    if (!box) return;
    var visible = state.awardsVisibleCount || AWARDS_LABEL_INITIAL_VISIBLE;
    if (visible < AWARDS_LABEL_INITIAL_VISIBLE) visible = AWARDS_LABEL_INITIAL_VISIBLE;
    if (visible > AWARDS_LABEL_MAX_COUNT) visible = AWARDS_LABEL_MAX_COUNT;
    state.awardsVisibleCount = visible;
    var rows = box.querySelectorAll('.pc-awards-row');
    for (var i = 0; i < rows.length; i++) {
      var idx = parseInt(rows[i].getAttribute('data-awards-index'), 10);
      rows[i].hidden = !(idx >= 1 && idx <= visible);
    }
    var addBtn = document.getElementById('pc-awards-add-btn');
    if (addBtn) {
      addBtn.hidden = visible >= AWARDS_LABEL_MAX_COUNT;
      addBtn.disabled = visible >= AWARDS_LABEL_MAX_COUNT;
    }
  }

  function renderAwardsLabelsPanel() {
    var box = document.getElementById('pc-awards-labels');
    var metaBox = document.getElementById('pc-personalization-meta');
    if (!box) return;
    if (metaBox) {
      metaBox.innerHTML = '';
      metaBox.hidden = true;
      metaBox.classList.remove('pc-pers-meta-panel--active');
    }
    box.hidden = false;
    box.innerHTML = '';
    state.awardsLabels = {};
    state.awardsVisibleCount = AWARDS_LABEL_INITIAL_VISIBLE;

    var intro = document.createElement('p');
    intro.className = 'pc-awards-intro';
    intro.textContent =
      'Inserisci il testo da stampare sulle targhette. Compila almeno un’etichetta; lascia vuote le righe non necessarie.';
    box.appendChild(intro);

    var list = document.createElement('div');
    list.className = 'pc-awards-list';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Etichette targhette');

    AWARDS_LABEL_DEFS.forEach(function (def) {
      state.awardsLabels[def.index] = '';
      var row = document.createElement('div');
      row.className = 'pc-awards-row';
      row.setAttribute('data-awards-index', String(def.index));

      var label = document.createElement('label');
      label.className = 'pc-awards-label';
      label.setAttribute('for', 'pc-awards-input-' + def.index);
      label.textContent = def.label;

      var hint = document.createElement('p');
      hint.className = 'pc-awards-hint';
      hint.textContent =
        'Inserisci i dati per questa targhetta; non compilare se non desideri la personalizzazione.';

      var fieldWrap = document.createElement('div');
      fieldWrap.className = 'pc-awards-field';

      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'pc-awards-input';
      input.id = 'pc-awards-input-' + def.index;
      input.name = 'properties[' + def.label + ']';
      input.maxLength = AWARDS_LABEL_MAX_LEN;
      input.autocomplete = 'off';
      input.setAttribute('data-awards-index', String(def.index));
      input.placeholder = 'Testo etichetta (max ' + AWARDS_LABEL_MAX_LEN + ' caratteri)';

      var counter = document.createElement('span');
      counter.className = 'pc-awards-counter';
      counter.id = 'pc-awards-counter-' + def.index;
      counter.textContent = '0/' + AWARDS_LABEL_MAX_LEN;

      input.addEventListener('input', function () {
        var val = String(input.value || '');
        if (val.length > AWARDS_LABEL_MAX_LEN) {
          val = val.substring(0, AWARDS_LABEL_MAX_LEN);
          input.value = val;
        }
        state.awardsLabels[def.index] = val;
        counter.textContent = val.length + '/' + AWARDS_LABEL_MAX_LEN;
        updateSummary();
      });

      fieldWrap.appendChild(input);
      fieldWrap.appendChild(counter);
      row.appendChild(label);
      row.appendChild(hint);
      row.appendChild(fieldWrap);
      list.appendChild(row);
    });

    box.appendChild(list);

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.id = 'pc-awards-add-btn';
    addBtn.className = 'pc-btn pc-btn-secondary pc-awards-add-btn';
    addBtn.textContent = 'Aggiungi etichetta';
    addBtn.addEventListener('click', function () {
      if (state.awardsVisibleCount >= AWARDS_LABEL_MAX_COUNT) return;
      state.awardsVisibleCount += 1;
      syncAwardsLabelVisibility();
      var focusEl = document.getElementById('pc-awards-input-' + state.awardsVisibleCount);
      if (focusEl) focusEl.focus();
    });
    box.appendChild(addBtn);
    syncAwardsLabelVisibility();
  }

  function initPersonalizationFromProduct() {
    var box = document.getElementById('pc-personalization-meta');
    var awardsBox = document.getElementById('pc-awards-labels');
    if (!box && !awardsBox) return;
    state.personalizationGeneral = {};
    state.personalizationApparel = {};
    applyAwardsStepChrome();
    if (isAwardsPersMode()) {
      renderAwardsLabelsPanel();
      return;
    }
    if (awardsBox) {
      awardsBox.hidden = true;
      awardsBox.innerHTML = '';
    }
    if (!box) return;
    box.hidden = false;
    box.classList.add('pc-pers-meta-panel--active');
    if (!usesMetaPersonalization()) {
      box.innerHTML = '';
      var empty = document.createElement('p');
      empty.className = 'pc-pers-empty';
      empty.textContent = 'Nessuna personalizzazione disponibile per questo prodotto.';
      box.appendChild(empty);
      return;
    }
    var list = state.product.personalizationOptions;
    var clothing = isClothingPersMode();
    box.innerHTML = '';
    var intro = document.createElement('p');
    intro.className = 'pc-pers-intro';
    intro.textContent = clothing
      ? 'Seleziona una o più personalizzazioni (importo calcolato sul subtotale merce).'
      : 'Seleziona una o più personalizzazioni. Alcune opzioni non sono combinabili tra loro.';
    box.appendChild(intro);

    var table = document.createElement('div');
    table.className = 'pc-pers-table';
    table.setAttribute('role', 'group');
    table.setAttribute('aria-label', clothing ? 'Personalizzazioni abbigliamento' : 'Personalizzazione');

    var thead = document.createElement('div');
    thead.className = 'pc-pers-table-head';
    var th1 = document.createElement('div');
    th1.textContent = 'Personalizzazione';
    var th2 = document.createElement('div');
    th2.textContent = 'Costo';
    thead.appendChild(th1);
    thead.appendChild(th2);
    table.appendChild(thead);

    function selectionMap() {
      return clothing ? state.personalizationApparel : state.personalizationGeneral;
    }

    function enforceExclusiveSelection(selectedKey) {
      if (clothing) return;
      var selectedOpt = null;
      (list || []).forEach(function (o) {
        if (o.key === selectedKey) selectedOpt = o;
      });
      if (!selectedOpt) return;
      var conflictKeys = getExclusiveConflictKeys(selectedOpt, list);
      if (!conflictKeys.length) return;
      var inputs = box.querySelectorAll('.pc-pers-card-input');
      for (var i = 0; i < inputs.length; i++) {
        var peer = inputs[i];
        var peerKey = peer.getAttribute('data-pers-key');
        if (conflictKeys.indexOf(peerKey) < 0) continue;
        if (peer.checked) peer.checked = false;
        state.personalizationGeneral[peerKey] = false;
      }
    }

    function bindChange(inp) {
      inp.addEventListener('change', function () {
        var key = inp.getAttribute('data-pers-key');
        selectionMap()[key] = inp.checked;
        if (inp.checked) enforceExclusiveSelection(key);
        syncMetaPersCardSelectedState();
        if (PC_DEBUG) dbg('PERSONALIZATION', getPersonalizationLineDetails());
        updateSummary();
      });
    }

    list.forEach(function (opt) {
      var slug = String(opt.key).replace(/[^a-zA-Z0-9_-]/g, '_');
      var rowWrap = document.createElement('div');
      rowWrap.className = 'pc-pers-table-row';

      var card = document.createElement('label');
      card.className = 'pc-pers-row pc-pers-card pc-pers-card--checkbox';
      card.setAttribute('data-pers-key', opt.key);
      card.setAttribute('data-pers-pct', String(opt.percentage));

      var inp = document.createElement('input');
      inp.className = 'pc-pers-card-input';
      inp.setAttribute('data-pers-key', opt.key);
      inp.type = 'checkbox';
      inp.id = (clothing ? 'pc-pers-app-' : 'pc-pers-gen-') + slug;

      var main = document.createElement('span');
      main.className = 'pc-pers-row-main';
      var textWrap = document.createElement('span');
      textWrap.className = 'pc-pers-row-text';
      var title = document.createElement('span');
      title.className = 'pc-pers-card-title';
      title.textContent = opt.label;
      textWrap.appendChild(title);
      if (opt.description) {
        var descEl = document.createElement('span');
        descEl.className = 'pc-pers-card-desc';
        descEl.textContent = opt.description;
        textWrap.appendChild(descEl);
      }
      main.appendChild(inp);
      main.appendChild(textWrap);

      var price = document.createElement('span');
      price.className = 'pc-pers-card-price';
      price.setAttribute('aria-live', 'polite');
      var baseNow = calculateBaseItemsTotal();
      var pctNum = Number(opt.percentage);
      var centsNow = isFinite(pctNum) ? Math.round((baseNow * pctNum) / 100) : 0;
      if (pctNum <= 0) {
        price.textContent = 'Incluso';
      } else {
        price.textContent = '+' + formatMoney(centsNow);
      }

      card.appendChild(main);
      card.appendChild(price);

      bindChange(inp);
      rowWrap.appendChild(card);
      table.appendChild(rowWrap);
    });

    box.appendChild(table);
    syncMetaPersCardSelectedState();
    refreshMetaPersCardPrices();
  }

  /**
   * Verifica se il prodotto è compatibile con il configuratore (matrice taglia/colore).
   * Richiede: almeno 1 variante; opzioni con valori o prodotto single-variant senza opzioni.
   * Ritorna false per: 0 varianti, options/values mancanti o malformati, assi vuoti.
   */
  function isProductCompatible() {
    var product = state.product;
    if (!product || typeof product !== 'object') return false;
    var variants = product.variants;
    if (!variants || !Array.isArray(variants) || variants.length === 0) return false;
    var options = product.options;
    if (options && Array.isArray(options)) {
      var hasValues = options.some(function (opt) {
        var v = normalizeOptionValues(opt && opt.values);
        return v && v.length > 0;
      });
      if (options.length > 0 && !hasValues) return false;
    }
    var colors = state.colorAxis ? state.colorAxis.values : ['—'];
    var sizes = state.sizeAxis ? state.sizeAxis.values : ['—'];
    if (!colors.length || !sizes.length) return false;
    return true;
  }

  /**
   * Mostra il fallback "Configurazione non disponibile" e nasconde CTA + modale.
   * Non genera errori; la PDP resta utilizzabile.
   */
  function showFallbackUnavailable() {
    var fallback = document.getElementById('pc-fallback-unavailable');
    var ctaArea = document.getElementById('pc-cta-area');
    var fallbackForm = document.getElementById('pc-standard-add-to-cart-fallback');
    if (fallback) { fallback.hidden = false; fallback.removeAttribute('hidden'); }
    if (ctaArea) ctaArea.classList.add('pc-hidden');
    closeModal();
    if (fallbackForm) fallbackForm.classList.remove('pc-hidden');
    unlockNativeAddToCart();
  }

  /** Blocca sticky ATC + form nativo nascosto (bypass tipico da smartphone). */
  function lockNativeAddToCart() {
    try {
      document.documentElement.classList.add('pc-configurator-active');
      window.__PC_CONFIGURATOR_ACTIVE = true;
    } catch (e) {}
    function blockAndOpenWizard(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      }
      try {
        openModal();
      } catch (err) {}
      return false;
    }
    var fallback = document.getElementById('pc-standard-add-to-cart-fallback');
    if (fallback && !fallback.dataset.pcLocked) {
      fallback.dataset.pcLocked = '1';
      fallback.querySelectorAll('form').forEach(function (form) {
        form.addEventListener('submit', blockAndOpenWizard, true);
      });
      fallback.querySelectorAll('button[type="submit"], input[type="submit"]').forEach(function (btn) {
        btn.addEventListener('click', blockAndOpenWizard, true);
      });
    }
    var sticky = document.getElementById('sticky-add-to-cart');
    if (sticky && !sticky.dataset.pcLocked) {
      sticky.dataset.pcLocked = '1';
      sticky.setAttribute('hidden', '');
      sticky.setAttribute('aria-hidden', 'true');
      sticky.querySelectorAll('button, input[type="submit"]').forEach(function (btn) {
        btn.disabled = true;
        btn.addEventListener('click', blockAndOpenWizard, true);
      });
    }
    document.querySelectorAll('button[form^="main-product-form-"]').forEach(function (btn) {
      if (btn.dataset.pcLocked) return;
      btn.dataset.pcLocked = '1';
      btn.addEventListener('click', blockAndOpenWizard, true);
    });
  }

  function unlockNativeAddToCart() {
    try {
      document.documentElement.classList.remove('pc-configurator-active');
      window.__PC_CONFIGURATOR_ACTIVE = false;
    } catch (e) {}
    var sticky = document.getElementById('sticky-add-to-cart');
    if (sticky) {
      sticky.removeAttribute('hidden');
      sticky.querySelectorAll('button, input[type="submit"]').forEach(function (btn) {
        btn.disabled = false;
      });
    }
  }

  function getEffectiveMinQty() {
    var min = 1;
    var qp = CONFIG && CONFIG.quantityPricing;
    if (qp && qp.enabled && qp.minQty > 0) min = Math.max(min, parseInt(qp.minQty, 10) || 1);
    var meta = state.product && state.product.personalizationMeta;
    if (meta && isClothingPersMode() && meta.minimumOrderQuantity != null && meta.minimumOrderQuantity > 0) {
      min = Math.max(min, parseInt(meta.minimumOrderQuantity, 10) || 1);
    }
    return min;
  }

  function openModal() {
    var overlay = document.getElementById('pc-modal-overlay');
    if (!overlay) return;
    overlay.removeAttribute('hidden');
    overlay.classList.add('pc-open');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('pc-modal-open');
    document.addEventListener('keydown', handleModalEsc);
  }

  function closeModal() {
    var overlay = document.getElementById('pc-modal-overlay');
    if (!overlay) return;
    overlay.classList.remove('pc-open');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('hidden', '');
    document.body.classList.remove('pc-modal-open');
    document.removeEventListener('keydown', handleModalEsc);
  }

  function handleModalEsc(e) {
    if (e.key === 'Escape') closeModal();
  }

  /**
   * Estrae stringhe dai valori opzione. Shopify options_with_values usa oggetti con .name o .value.
   * Non usare filter aggressivo: la logica matrice si basa solo su option values reali.
   */
  function normalizeOptionValues(vals) {
    if (!vals || !Array.isArray(vals)) return [];
    return vals.map(function (v) {
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object') {
        var s = v.value != null ? v.value : v.name;
        if (s != null && s !== '') return String(s);
      }
      return String(v);
    });
  }

  function detectVariantAxes() {
    var product = state.product;
    if (!product) return;
    var options = product.options;
    if (!Array.isArray(options)) options = [];
    var ck = CONFIG.labels.color || [];
    var sk = CONFIG.labels.size || [];
    var pk = CONFIG.labels.print || [];
    var qk = CONFIG.labels.quantity || [];
    state.colorAxis = null;
    state.sizeAxis = null;
    state.printAxis = null;
    var assigned = {};
    options.forEach(function (opt, idx) {
      var vals = normalizeOptionValues(opt && opt.values);
      if (optionNameMatches(opt && opt.name, pk)) {
        state.printAxis = { index: idx, name: opt.name, values: vals };
        assigned[idx] = true;
      } else if (optionNameMatches(opt && opt.name, ck)) {
        state.colorAxis = { index: idx, name: opt.name, values: vals };
        assigned[idx] = true;
      } else if (optionNameMatches(opt && opt.name, sk) || optionNameMatches(opt && opt.name, qk)) {
        if (!state.sizeAxis) {
          state.sizeAxis = { index: idx, name: opt.name, values: vals };
          assigned[idx] = true;
        }
      }
    });
    var leftover = [];
    options.forEach(function (opt, idx) {
      if (!assigned[idx]) {
        leftover.push({
          opt: opt,
          idx: idx,
          vals: normalizeOptionValues(opt && opt.values)
        });
      }
    });
    if (!state.colorAxis && !state.sizeAxis && leftover.length >= 2) {
      state.colorAxis = { index: leftover[0].idx, name: leftover[0].opt.name, values: leftover[0].vals };
      state.sizeAxis = { index: leftover[1].idx, name: leftover[1].opt.name, values: leftover[1].vals };
    } else if (leftover.length === 1) {
      var left = leftover[0];
      if (!state.sizeAxis) {
        state.sizeAxis = { index: left.idx, name: left.opt.name, values: left.vals };
      } else if (!state.colorAxis) {
        state.colorAxis = { index: left.idx, name: left.opt.name, values: left.vals };
      }
    } else if (!state.colorAxis && !state.sizeAxis && options.length === 1) {
      var opt0 = options[0];
      var vals0 = normalizeOptionValues(opt0 && opt0.values);
      state.sizeAxis = { index: 0, name: opt0 && opt0.name, values: vals0 };
      state.colorAxis = null;
    }
  }

  function buildVariantMap() {
    var product = state.product;
    if (!product || !product.variants || !Array.isArray(product.variants)) return;
    var map = {};
    product.variants.forEach(function (v) {
      map[[v.option1, v.option2, v.option3].filter(Boolean).join('::')] = v;
    });
    state.variantMap = map;
  }

  function getVariantForOptions(opt1, opt2, opt3) {
    var key = [opt1, opt2, opt3].filter(Boolean).join('::');
    if (state.variantMap[key]) return state.variantMap[key];
    if (!opt1 && !opt2 && !opt3) return null;
    var product = state.product;
    if (!product || !product.variants) return null;
    return product.variants.find(function (v) {
      if (opt1 && v.option1 !== opt1) return false;
      if (opt2 && v.option2 !== opt2) return false;
      if (opt3 && v.option3 !== opt3) return false;
      return true;
    }) || null;
  }

  /** Riga riepilogo merce: con QP solo da metafield/merch map, mai variant.price. */
  function computeSummaryLineTotalCents(qpActive, vid, qty, merchMap, legacyUnitCents) {
    var out;
    if (qpActive) {
      if (merchMap && merchMap[vid] != null) out = merchMap[vid];
      else {
        var tq = getTotalQuantity();
        if (tq > 0 && qty > 0 && CONFIG.quantityPricing && CONFIG.quantityPricing.basePriceCents > 0) {
          out = Math.round((getQuantityPricingMerchandiseTotalCents() * qty) / tq);
        } else out = 0;
      }
    } else {
      out = Math.round((legacyUnitCents || 0) * qty);
    }
    return out;
  }

  function pcWarnSummaryRow(fnName, payload) {
    if (!PC_DEBUG) return;
    dbg('TOTAL', { summary: fnName, payload: payload });
  }

  /** Cap massimo ordine per variante se Shopify nega vendita oltre stock (il configuratore non impone sempre max sull'input). */
  function getConfiguratorInventoryCapForVariant(variant) {
    if (!variant) return null;
    if (variant.inventory_management === 'shopify' && variant.inventory_policy === 'deny' && variant.inventory_quantity != null) {
      var iq = parseInt(variant.inventory_quantity, 10);
      if (!isNaN(iq) && iq >= 0) return iq;
    }
    return null;
  }

  function pcWarnStock(variant, source, extra) {
    if (!PC_DEBUG || !variant) return;
    var vid = String(variant.id);
    var sel = state.quantities[vid] != null ? state.quantities[vid] : 0;
    try {
      dbg('DATA', Object.assign({
        variantId: variant.id,
        title: variant.title != null ? variant.title : '',
        rawInventoryQuantity: variant.inventory_quantity,
        inventoryPolicy: variant.inventory_policy,
        inventoryManagement: variant.inventory_management,
        available: variant.available,
        selectedQty: sel,
        maxQtyUsedByConfigurator: getConfiguratorInventoryCapForVariant(variant),
        source: source || ''
      }, extra || {}));
    } catch (e) {}
  }

  function debugLogAllVariantPricesFromLiquid() {
    if (!PC_DEBUG || !state.product || !state.product.variants) return;
    state.product.variants.forEach(function (vv) {
      dbg('DATA', {
        variantId: vv.id,
        title: vv.title,
        rawPrice: vv.price,
        cents: centsFromShopifyVariantPrice(vv.price)
      });
    });
  }

  /** Se basePrice nel metafield è stato interpretato come 49€→4900¢ ma la variante è 49¢ (0,49€), riallinea. */
  function renormalizeQuantityPricingBaseCentsFromVariantMinor() {
    if (!CONFIG.quantityPricing || !CONFIG.quantityPricing.enabled) return;
    var bc = CONFIG.quantityPricing.basePriceCents;
    if (bc == null || isNaN(bc) || bc <= 0) return;
    var product = state.product;
    if (!product || !product.variants || !product.variants.length) return;
    var hint = centsFromShopifyVariantPrice(product.variants[0].price);
    if (!(hint > 0 && hint < 1000)) return;
    if (bc === hint * 100) {
      CONFIG.quantityPricing.basePriceCents = hint;
      pcDbgQuantityPricing('renormalizeQuantityPricingBaseCentsFromVariantMinor', { previousBasePriceCents: bc, correctedTo: hint });
    }
  }

  /** Alias: prezzo variante Shopify in centesimi. */
  function variantPriceCents(v) {
    if (!v) return 0;
    return centsFromShopifyVariantPrice(v.price);
  }

  /**
   * Fascia qtyTable: usa la riga con minQty più alta tra quelle con minQty ≤ totalQty.
   * Ritorna unitPriceCents o null se tabella assente / non applicabile.
   */
  function resolveQtyTableUnitPriceCents(totalQty, config) {
    if (!config || typeof config !== 'object' || !Array.isArray(config.qtyTable) || config.qtyTable.length === 0) {
      return null;
    }
    var tq = parseInt(totalQty, 10);
    if (isNaN(tq) || tq < 0) return null;
    var rows = config.qtyTable
      .filter(function (r) {
        return r && typeof r === 'object' && r.minQty != null && r.unitPriceCents != null;
      })
      .map(function (r) {
        return { minQty: parseInt(r.minQty, 10), unitPriceCents: parseInt(r.unitPriceCents, 10) };
      })
      .filter(function (r) {
        return !isNaN(r.minQty) && !isNaN(r.unitPriceCents);
      })
      .sort(function (a, b) {
        return b.minQty - a.minQty;
      });
    for (var i = 0; i < rows.length; i++) {
      if (tq >= rows[i].minQty) return rows[i].unitPriceCents;
    }
    return null;
  }

  /**
   * Prezzo unitario base merce (centesimi) per una variante.
   * Legacy: variantPriceCents. Branch qtyTable: se CONFIG.useQtyTableForBaseUnitPrice e tabella valida.
   * @param {number} quantity quantità riga (estensibile; tier usa getTotalQuantity via state globale)
   * @param {object} stateObj state configuratore
   * @param {object} variant variante Shopify
   */
  function getBaseUnitPriceCents(quantity, stateObj, variant) {
    var legacy = variantPriceCents(variant);
    if (CONFIG.quantityPricing && CONFIG.quantityPricing.enabled) {
      var map = getQuantityPricingLineMerchCentsMap();
      var vid = String(variant.id);
      var qLine = state.quantities[vid] || 0;
      var lineMerch = map[vid];
      if (lineMerch != null && qLine > 0) {
        var unit = Math.round(lineMerch / qLine);
        pcDbgQuantityPricing('getBaseUnitPriceCents (QP)', {
          variantId: vid,
          lineQty: qLine,
          lineMerchCents: lineMerch,
          unitPriceCents: unit
        });
        if (!isNaN(unit) && unit >= 0) return unit;
      }
      var tq = getTotalQuantity();
      if (tq > 0 && qLine > 0) {
        var merch = getQuantityPricingMerchandiseTotalCents();
        var lm = Math.round((merch * qLine) / tq);
        var uFall = Math.round(lm / qLine);
        pcDbgQuantityPricing('getBaseUnitPriceCents (QP proportional fallback)', { variantId: vid, unitPriceCents: uFall });
        if (!isNaN(uFall) && uFall >= 0) return uFall;
      }
      return 0;
    }
    if (!CONFIG || !CONFIG.useQtyTableForBaseUnitPrice) return legacy;
    if (!Array.isArray(CONFIG.qtyTable) || CONFIG.qtyTable.length === 0) return legacy;
    var totalQty = typeof getTotalQuantity === 'function' ? getTotalQuantity() : 0;
    var tier = resolveQtyTableUnitPriceCents(totalQty, CONFIG);
    if (tier == null || isNaN(tier)) return legacy;
    return tier;
  }

            var FALLBACK_COLORS = {
    '001-white': '#f5f5f5',
    '002-black': '#1a1a1a',
    '003-navy': '#0d47a1',
    '004-red': '#c62828',
    '005-darkgrey': '#4c4c4c',
    '006-olive': '#827717',
    '012-deepred': '#c62828',
    '039-darkgreen': '#1e5121',
    '045-darkolive': '#554d0f',
    '048-denim': '#3f5f8a',
    '049-lightblue': '#1c88ff',
    '050-powdergrey': '#757575',
    '056-forestgreen': '#2e7d32',
    '058-deepgreen': '#2e7d32',
    '063-iceblue': '#1565c0',
    '067-oceanblue': '#1565c0',
    '1-black': '#1a1a1a',
    '10-navy': '#0d47a1',
    '28-light-brown': '#7e564a',
    '3-white': '#f5f5f5',
    '30-white': '#f5f5f5',
    '319-darkgrey/white': 'linear-gradient(90deg,#4c4c4c 50%,#f5f5f5 50%)',
    '32-forestgreen': '#2e7d32',
    '32-navy': '#0d47a1',
    '321-white/navy': 'linear-gradient(90deg,#f5f5f5 50%,#0d47a1 50%)',
    '322-black/white': 'linear-gradient(90deg,#1a1a1a 50%,#f5f5f5 50%)',
    '323-navy/white': 'linear-gradient(90deg,#0d47a1 50%,#f5f5f5 50%)',
    '32v-navy-out': '#0d47a1',
    '36-black': '#1a1a1a',
    '38-bottlegreen': '#00695c',
    '40-red': '#c62828',
    '44-orange': '#ef6c00',
    '47-kellygreen': '#2e7d32',
    '51-royalblue': '#1565c0',
    '52-lightpink': '#ff207b',
    '57-fuchsia': '#d5006d',
    '60-natural': '#d7ccc8',
    '68-platinumgrey': '#757575',
    '70-fuchsia': '#d5006d',
    '74-pacificblue': '#1565c0',
    '76-royalblue': '#1565c0',
    '79-mossgreen': '#2e7d32',
    '8-red': '#c62828',
    '94-heathergrey': '#696969',
    'ab449-amalfiblue': '#1565c0',
    acciaio: '#9e9e9e',
    acciaioinossidabile: '#b0b0b0',
    acqua: '#4dd0e1',
    acquamarina: '#4dd0e1',
    'acye-acid-yellow': '#f9a825',
    'ag515-applegreen': '#2e7d32',
    'ag553-amalfigreen': '#2e7d32',
    'ag673-amalfigrey': '#757575',
    'al565-acidlime': '#c0ca33',
    antracite: '#37474f',
    'aqwh-aqua/white': '#f5f5f5',
    arancio: '#ef6c00',
    arancione: '#ef6c00',
    arancionefluo: '#ef6c00',
    arancionetrasparente: 'rgba(239,108,0,0.35)',
    arcobaleno: 'linear-gradient(90deg,#e53935,#fb8c00,#fdd835,#43a047,#1e88e5,#8e24aa)',
    argento: '#c0c0c0',
    avana: '#8b6914',
    avorio: '#fffff0',
    'ay202-amalfiyellow': '#f9a825',
    'az-deepnavy': '#0d47a1',
    azzurro: '#4FC3F7',
    azzurroacqua: '#4fc3f7',
    azzurrotrasparente: 'rgba(79,195,247,0.35)',
    'bb406-blushblue': '#1565c0',
    'bck-black': '#1a1a1a',
    'bck/gre-black/grey': '#1a1a1a',
    'bck/lim-black/lime': '#1a1a1a',
    'bck/ora-black/orange': '#ef6c00',
    'bck/red-black/red': '#1a1a1a',
    'bck/whi-black/white': '#1a1a1a',
    beige: '#d7ccc8',
    'bg540-bottlegreen': '#00695c',
    'bh-brightroyal': '#1565c0',
    bianco: '#f5f5f5',
    'bianco\arancio': 'linear-gradient(90deg,#f5f5f5 50%,#ef6c00 50%)',
    'bianco\azzurro': 'linear-gradient(90deg,#f5f5f5 50%,#4FC3F7 50%)',
    'bianco\blu': 'linear-gradient(90deg,#f5f5f5 50%,#1565c0 50%)',
    'bianco\giallo': 'linear-gradient(90deg,#f5f5f5 50%,#f9a825 50%)',
    'bianco\rosso': 'linear-gradient(90deg,#f5f5f5 50%,#c62828 50%)',
    'bianco\royal': 'linear-gradient(90deg,#f5f5f5 50%,#1565c0 50%)',
    'bianco\verde': 'linear-gradient(90deg,#f5f5f5 50%,#2e7d32 50%)',
    biancoarancione: '#ef6c00',
    biancoavorio: '#fffff0',
    biancoblu: '#f5f5f5',
    biancogiallo: '#f5f5f5',
    bianconero: '#f5f5f5',
    biancorosso: '#f5f5f5',
    biancotrasparente: 'rgba(255,255,255,0.45)',
    biancoverde: '#f5f5f5',
    'bk-black': '#1a1a1a',
    'bl-black': '#1a1a1a',
    'bl002-black': '#1a1a1a',
    'blac-black': '#1a1a1a',
    black: '#1a1a1a',
    blackbrown: '#3e2723',
    'blbl-black/black': 'linear-gradient(90deg,#1a1a1a 50%,#1a1a1a 50%)',
    'blblw-black/black/white': 'linear-gradient(90deg,#1a1a1a 50%,#1a1a1a 50%)',
    'blcb-black/carbon': '#1a1a1a',
    'blhea-black-heather': '#171717',
    'blk-black': '#1a1a1a',
    'bllim-black/lime-green': 'linear-gradient(90deg,#1a1a1a 50%,#2e7d32 50%)',
    'blm-bluemidnight': '#1565c0',
    'blmebl-black-melange/black': 'linear-gradient(90deg,#171717 50%,#1a1a1a 50%)',
    'blo-blackopal': '#1a1a1a',
    'blor-black/orange': 'linear-gradient(90deg,#1a1a1a 50%,#ef6c00 50%)',
    'blrd-black/red': 'linear-gradient(90deg,#1a1a1a 50%,#c62828 50%)',
    'blsi-black/silver': 'linear-gradient(90deg,#1a1a1a 50%,#c0c0c0 50%)',
    blu: '#1565c0',
    'blu-navy': '#0d47a1',
    bluchiaro: '#64b5f6',
    blucorallo: '#5c6bc0',
    blue: '#1565c0',
    blughiaccio: '#b3e5fc',
    blumedio: '#1e88e5',
    blumelange: '#5c7c9a',
    'blumeny-blue-melange/navy': 'linear-gradient(90deg,#135bad 50%,#0d47a1 50%)',
    blunavy: '#0d47a1',
    bluoceano: '#0277bd',
    bluprocess: '#1565c0',
    blurosso: '#c62828',
    bluroyal: '#1565c0',
    bluroyaltrasparente: 'rgba(21,101,192,0.35)',
    bluscuro: '#0d47a1',
    blutrasparente: 'rgba(21,101,192,0.35)',
    'blwh-black/white': 'linear-gradient(90deg,#1a1a1a 50%,#f5f5f5 50%)',
    'blwhgre-black/white/grey': 'linear-gradient(90deg,#1a1a1a 50%,#f5f5f5 50%)',
    'blwhl-black/white/lime-green': 'linear-gradient(90deg,#1a1a1a 50%,#f5f5f5 50%)',
    'blwhrd-black/white/red': 'linear-gradient(90deg,#1a1a1a 50%,#f5f5f5 50%)',
    'blwht-black/white/turquoise': 'linear-gradient(90deg,#1a1a1a 50%,#f5f5f5 50%)',
    'bm504-blushmint': '#66bb6a',
    'bod-bordeaux': '#6d1b2a',
    'bog-bottlegreen': '#00695c',
    'bor-brilliantorange': '#ef6c00',
    bordeaux: '#6d1b2a',
    bottle: '#00695c',
    bottlegreen: '#00695c',
    'bp299-blushpink': '#c2185b',
    'br-brown': '#5d4037',
    'br145-brown': '#5d4037',
    'brblny-bright-blue/navy': 'linear-gradient(90deg,#1565c0 50%,#0d47a1 50%)',
    brick: '#c62828',
    bronzo: '#cd7f32',
    brown: '#5d4037',
    'brr-brightroyal': '#1565c0',
    carbone: '#263238',
    carbonetrasparente: 'rgba(38,50,56,0.4)',
    'cb008-cobaltblue': '#1565c0',
    'cbbl-carbon/black': '#1a1a1a',
    'cbrd-carbon/red': '#c62828',
    celeste: '#4FC3F7',
    'cg-convoygrey': '#757575',
    'cg554-camogreen': '#2e7d32',
    'cg884-chiligold': '#c9a227',
    champagne: '#f3e5ab',
    ciano: '#00acc1',
    'clo-charcoal/orange': 'linear-gradient(90deg,#455a64 50%,#ef6c00 50%)',
    cloudblue: '#81d4fa',
    coloreunico: '#9e9e9e',
    'cr-classicred': '#c62828',
    cromato: '#d0d0d0',
    cyan: '#00acc1',
    darkblue: '#0d47a1',
    'db931-denim/burgundy': '#3f5f8a',
    deepseagreen: '#00695c',
    denim: '#3f5f8a',
    'dg-darkgrey': '#4c4c4c',
    'dg670-darkgrey': '#4c4c4c',
    'dgr-dark-green': '#1e5121',
    'dgrbl-dark-green/black': 'linear-gradient(90deg,#1e5121 50%,#1a1a1a 50%)',
    'dgre-dark-grey': '#4c4c4c',
    'dh933-denim/heathergrey': 'linear-gradient(90deg,#3f5f8a 50%,#696969 50%)',
    'dn932-denim/navy': 'linear-gradient(90deg,#3f5f8a 50%,#0d47a1 50%)',
    'do-darkolive': '#554d0f',
    'dor-dark-orange': '#9b4600',
    'dry-darkroyal': '#0e427d',
    dustypink: '#d4a5a5',
    ecru: '#f5f0e1',
    ecrublu: '#f5f0e1',
    ecrunero: '#f5f0e1',
    'fegr-fern-green': '#2e7d32',
    'fg-forestgreen': '#2e7d32',
    'fn-frenchnavy': '#0d47a1',
    'fogr-foggy-green': '#2e7d32',
    'fr007-firered': '#c62828',
    'fu310-fuchsia': '#d5006d',
    fucsia: '#d5006d',
    'g-yellow': '#f9a825',
    giallo: '#f9a825',
    giallofluo: '#f9a825',
    'go-gold': '#c9a227',
    'go210-gold': '#c9a227',
    gold: '#c9a227',
    'goye-gold-yellow': '#f9a825',
    granito: '#616161',
    gray: '#757575',
    green: '#2e7d32',
    'grehe-grey-heather': '#696969',
    'greheny-grey-heather/navy': 'linear-gradient(90deg,#696969 50%,#0d47a1 50%)',
    grey: '#757575',
    grigio: '#757575',
    grigiochiaro: '#bdbdbd',
    grigioghiaia: '#9e9e9e',
    grigiointermedio: '#757575',
    grigiomelange: '#9e9e9e',
    grigioopaco: '#616161',
    grigioscuro: '#424242',
    grigiotempesta: '#546e7a',
    'grmedgr-green-melange/dark-green': 'linear-gradient(90deg,#29712d 50%,#1e5121 50%)',
    'grpgr-graphite/graphite-white': '#f5f5f5',
    'grpwh-graphite/white': '#f5f5f5',
    'gy-greyheather': '#696969',
    'gyh-greyheather': '#696969',
    haleblue: '#4a6fa5',
    'hb609-heatherblue': '#135bad',
    'hd-darkheathergrey': '#444444',
    'hd-grigiomelangescuro': '#444444',
    heathercharcoal: '#455a64',
    'hg601-heathergreyfog': '#696969',
    'hg610-heathergrey': '#696969',
    'hp-heatherpurple': '#5f188b',
    'ig531-ivygreen': '#2e7d32',
    'irgr-irish-green': '#2e7d32',
    'irgrw-irish-green/white': 'linear-gradient(90deg,#2e7d32 50%,#f5f5f5 50%)',
    'jadgr-jade-green': '#2e7d32',
    'kg520-kellygreen': '#2e7d32',
    'kh555-khaki': '#8d8a5b',
    khaki: '#8d8a5b',
    lavanda: '#b39ddb',
    'lb408-lotusblue': '#1565c0',
    'lb431-lakeblue': '#1565c0',
    'lb880-lightblue': '#1c88ff',
    'lbl-lightblue': '#1c88ff',
    'lblu-light-blue': '#1c88ff',
    'ldeme-light-denim-melange': '#4d73a7',
    legno: '#8d6e63',
    lightblue: '#4FC3F7',
    lilla: '#ce93d8',
    'lim-lime-green': '#2e7d32',
    lime: '#c0ca33',
    limetrasparente: 'rgba(192,202,51,0.4)',
    'limli-lime-green/lime-green-white': 'linear-gradient(90deg,#2e7d32 50%,#2e7d32 50%)',
    'lm-lime': '#c0ca33',
    'lmebl-light-melange/black': '#202020',
    'lp313-lotuspink': '#c2185b',
    'lrd-light-red': '#ff3636',
    'lrdbl-light-red/black': 'linear-gradient(90deg,#ff3636 50%,#1a1a1a 50%)',
    'lye-light-yellow': '#ffe332',
    'mab-marinablue': '#1565c0',
    magenta: '#c2185b',
    marrone: '#5d4037',
    marronemelange: '#8d6e63',
    'mb-mineralblue': '#1565c0',
    melangenaturale: '#d2c4b0',
    menta: '#66bb6a',
    'mf312-metafuchsia': '#d5006d',
    'mg211-metagold': '#c9a227',
    'mi-mint': '#66bb6a',
    misto: 'linear-gradient(90deg,#e53935,#fb8c00,#fdd835,#43a047,#1e88e5,#8e24aa)',
    'mm509-millennialmint': '#66bb6a',
    'mo226-metaorange': '#ef6c00',
    'mo255-melonorange': '#ef6c00',
    'mt439-metaturquoise': '#00acc1',
    multicolore: 'linear-gradient(90deg,#e53935,#fb8c00,#fdd835,#43a047,#1e88e5,#8e24aa)',
    'my215-mellowyellow': '#f9a825',
    'na-natural': '#d7ccc8',
    'na003-navy': '#0d47a1',
    'na100-natural': '#d7ccc8',
    natural: '#d7ccc8',
    naturale: '#d7ccc8',
    'naturale/ecru': 'linear-gradient(90deg,#d7ccc8 50%,#f5f0e1 50%)',
    'nav-navy': '#0d47a1',
    'nav-navyblue': '#0d47a1',
    'nav/lbl-navy/lightblue': '#1260d9',
    'nav/whi-navy/white': '#f5f5f5',
    'nav/yew-navy/yellow': '#f9a825',
    navy: '#0d47a1',
    'navy-navy': '#0d47a1',
    navyblue: '#0d47a1',
    navymelange: '#0c4091',
    'ne-neonmint': '#66bb6a',
    nero: '#1a1a1a',
    'nero-1': '#1a1a1a',
    nerobrillante: '#111111',
    nerogrigio: '#757575',
    neromelange: '#424242',
    neroopaco: '#212121',
    nerotrasparente: 'rgba(26,26,26,0.4)',
    'np009-navypure': '#0d47a1',
    'ny-navy': '#0d47a1',
    'nybrbl-navy/bright-blue': 'linear-gradient(90deg,#0d47a1 50%,#1565c0 50%)',
    'nyny-navy/navy': 'linear-gradient(90deg,#0d47a1 50%,#0d47a1 50%)',
    'nynyw-navy/navy-white': 'linear-gradient(90deg,#0d47a1 50%,#f5f5f5 50%)',
    'nyrdnyw-navy/red-navy-white': 'linear-gradient(90deg,#0d47a1 50%,#f5f5f5 50%)',
    'nyrdw-navy/red-white': 'linear-gradient(90deg,#0d47a1 50%,#f5f5f5 50%)',
    'nytu-navy/turquoise': 'linear-gradient(90deg,#0d47a1 50%,#00acc1 50%)',
    'nywh-navy/white': 'linear-gradient(90deg,#0d47a1 50%,#f5f5f5 50%)',
    'o-orange': '#ef6c00',
    oatmeal: '#e8dcc8',
    'ocb-oceanblue': '#1565c0',
    oceanblue2: '#0288d1',
    'off-white': '#fafafa',
    'ol-olive': '#827717',
    oliva: '#827717',
    'op303-orchidpink': '#c2185b',
    'or-orange': '#ef6c00',
    'or235-orange': '#ef6c00',
    'ora-orange': '#ef6c00',
    orange: '#ef6c00',
    'orbk-orange/black': 'linear-gradient(90deg,#ef6c00 50%,#1a1a1a 50%)',
    oro: '#c9a227',
    ororosa: '#b76e79',
    ottanio: '#2a9d8f',
    'ow-offwhite': '#f5f5f5',
    'ow101-offwhite': '#f5f5f5',
    paleblushpink: '#e8c4c4',
    'pb-petrolblue': '#1565c0',
    'pe-purple': '#6a1b9a',
    'pg518-popgreen': '#2e7d32',
    'pg874-pacificgrey': '#757575',
    'pi-pink': '#c2185b',
    pink: '#c2185b',
    'pl986-pixellime': '#c0ca33',
    'po230-pumpkinorange': '#ef6c00',
    'po233-pureorange': '#ef6c00',
    prugna: '#6a1b4d',
    'pt734-popturquoise': '#00acc1',
    'pu-purple': '#6a1b9a',
    'pu350-purple': '#6a1b9a',
    purple: '#6a1b9a',
    'py208-popyellow': '#f9a825',
    'r6-retroheatherroyal': '#135bad',
    rame: '#b87333',
    'rb-royalblue': '#1565c0',
    'rb450-royalblue': '#1565c0',
    'rd-red': '#c62828',
    'rdbl-red/black': 'linear-gradient(90deg,#c62828 50%,#1a1a1a 50%)',
    'rdny-red/navy': 'linear-gradient(90deg,#c62828 50%,#0d47a1 50%)',
    'rdrdw-red/red-white': 'linear-gradient(90deg,#c62828 50%,#f5f5f5 50%)',
    'rdwh-red/white': 'linear-gradient(90deg,#c62828 50%,#f5f5f5 50%)',
    're004-red': '#c62828',
    'reblu-regatta-blue': '#1565c0',
    red: '#c62828',
    'red/bck-red/black': 'linear-gradient(90deg,#c62828 50%,#c62828 50%)',
    'rg732-realgreen': '#2e7d32',
    rosa: '#c2185b',
    rosatrasparente: 'rgba(194,24,91,0.35)',
    rosso: '#c62828',
    rossomelange: '#b85c5c',
    rossoscuro: '#8e0000',
    rossoscuromelange: '#8e4a4a',
    rossotrasparente: 'rgba(198,40,40,0.35)',
    'roy/bck-royal/black': '#1565c0',
    'roya-royal': '#1565c0',
    royal: '#1565c0',
    'rp351-radiantpurple': '#6a1b9a',
    'rt733-realturquoise': '#00acc1',
    'rx-retroheathergreen': '#29712d',
    'ry-royal': '#1565c0',
    'ryny-royal/navy': 'linear-gradient(90deg,#1565c0 50%,#0d47a1 50%)',
    'ryryw-royal/royal-white': 'linear-gradient(90deg,#1565c0 50%,#1565c0 50%)',
    'rywh-royal/white': 'linear-gradient(90deg,#1565c0 50%,#f5f5f5 50%)',
    'safo-safetyorange': '#ef6c00',
    'safy-safetyyellow': '#f9a825',
    salvia: '#9ccc65',
    'sb410-skyblue': '#1565c0',
    'sbl-surfblue': '#1565c0',
    'sblu-sky-blue': '#1565c0',
    'sg620-sportgrey': '#757575',
    silver: '#c0c0c0',
    skyblue: '#87CEEB',
    'slg-slategrey': '#757575',
    'sogrey-soft-grey': '#757575',
    'sopi-softpink': '#c2185b',
    'spk-sweetpink': '#c2185b',
    'spor-spicy-orange': '#ef6c00',
    'sre-scarletred': '#c62828',
    'stbl-stone/black': '#1a1a1a',
    'stblu-steel-blue': '#1565c0',
    sughero: '#c4a35a',
    'sy201-solaryellow': '#f9a825',
    titanio: '#8a8f98',
    'tm-forestgreen': '#2e7d32',
    tortora: '#a0937d',
    trasparente: 'rgba(224,242,254,0.55)',
    trasparentesatinato: 'rgba(207,216,220,0.55)',
    tricolore: 'linear-gradient(90deg,#009246 0 33.33%,#ffffff 33.33% 66.66%,#ce2b37 66.66% 100%)',
    'tu-turquoise': '#00acc1',
    turchese: '#00acc1',
    twilightgrey: '#78909c',
    'uk552-urbankhaki': '#8d8a5b',
    'un006-navyblue': '#0d47a1',
    unico: '#9e9e9e',
    'uo231-urbanorange': '#ef6c00',
    verde: '#2e7d32',
    'verde-oliva': '#827717',
    verdeacqua: '#2e7d32',
    verdebrillante: '#43a047',
    verdeclaro: '#2e7d32',
    verdeescuro: '#2e7d32',
    verdefelce: '#558b2f',
    verdefluo: '#2e7d32',
    verdeforesta: '#2e7d32',
    verdelime: '#c0ca33',
    verdemela: '#8bc34a',
    verdemelange: '#7a9e6a',
    verdemilitare: '#2e7d32',
    verdenebbia: '#9ccc65',
    verdeoliva: '#827717',
    verdescuro: '#1b5e20',
    verdetrasparente: 'rgba(46,125,50,0.35)',
    verdevertodimare: '#00897b',
    verdiano: '#1b4d3e',
    'vf-vintageheathernavy': '#0c4091',
    'vh-vintageheatherred': '#b22424',
    viola: '#6a1b9a',
    violascuro: '#4a148c',
    'vt705-veryturquoise': '#00acc1',
    'wh-white': '#f5f5f5',
    'wh001-white': '#f5f5f5',
    'whbl-white/black': 'linear-gradient(90deg,#f5f5f5 50%,#1a1a1a 50%)',
    'whcb-white/carbon': '#f5f5f5',
    'whi-white': '#f5f5f5',
    'whi/nav-white/navy': '#f5f5f5',
    'whi/red-white/red': '#f5f5f5',
    white: '#f5f5f5',
    whiteblack: 'linear-gradient(90deg,#f5f5f5 50%,#1a1a1a 50%)',
    'whny-white/navy': 'linear-gradient(90deg,#f5f5f5 50%,#0d47a1 50%)',
    'whnyw-white/navy-white': 'linear-gradient(90deg,#f5f5f5 50%,#f5f5f5 50%)',
    'whrd-white/red': 'linear-gradient(90deg,#f5f5f5 50%,#c62828 50%)',
    'whry-white/royal': 'linear-gradient(90deg,#f5f5f5 50%,#1565c0 50%)',
    'wht-white': '#f5f5f5',
    'wr907-white/royalblue': 'linear-gradient(90deg,#f5f5f5 50%,#1565c0 50%)',
    'ye-yellow': '#f9a825',
    'yebk-yellow-black': '#f9a825',
    'yel-yellow': '#f9a825',
    yellow: '#f9a825',
    'yt-skyblue': '#1565c0',
    'zu-azureblue': '#1565c0'
  };;;;;;

  function isGradientSwatchValue(val) {
    return typeof val === 'string' && val.indexOf('gradient') !== -1;
  }

  function applySwatchStyleToEl(swatchEl, swatchStyle) {
    if (!swatchEl || !swatchStyle) return;
    if (swatchStyle.type === 'color' && swatchStyle.value) {
      if (isGradientSwatchValue(swatchStyle.value)) {
        swatchEl.style.backgroundImage = swatchStyle.value;
        swatchEl.style.backgroundColor = 'transparent';
        swatchEl.style.backgroundSize = '100% 100%';
      } else {
        swatchEl.style.backgroundColor = swatchStyle.value;
      }
    } else if (swatchStyle.type === 'image' && swatchStyle.value) {
      var src = typeof swatchStyle.value === 'string'
        ? swatchStyle.value
        : (swatchStyle.value.src || swatchStyle.value);
      swatchEl.style.backgroundImage = 'url(' + src + ')';
    }
  }

  function getColorSwatchMap() {
    var map = {};
    var product = state.product;
    if (product && product.color_swatches && typeof product.color_swatches === 'object') {
      Object.keys(product.color_swatches).forEach(function (name) {
        var val = product.color_swatches[name];
        if (val == null) return;
        var style = null;
        if (typeof val === 'string') {
          if (val.indexOf('#') === 0 || val.indexOf('rgb') === 0 || isGradientSwatchValue(val)) {
            style = { type: 'color', value: val };
          } else {
            style = { type: 'image', value: val };
          }
        }
        if (style) map[name] = style;
      });
    }
    var colors = state.colorAxis ? state.colorAxis.values : [];
    colors.forEach(function (color) {
      if (map[color]) return;
      var key = (color || '').toLowerCase().replace(/\s+/g, '');
      if (FALLBACK_COLORS[key]) map[color] = { type: 'color', value: FALLBACK_COLORS[key] };
    });
    return map;
  }

  function buildSizeColorMatrix() {
    var container = document.getElementById('pc-size-color-matrix');
    var loading = document.getElementById('pc-matrix-loading');
    if (!container) return;
    var colors = state.colorAxis ? state.colorAxis.values : ['—'];
    var sizes = state.sizeAxis ? state.sizeAxis.values : ['—'];
    var swatchMap = getColorSwatchMap();
    if (loading) loading.remove();
    var table = document.createElement('table');
    table.className = 'pc-matrix-table';
    table.setAttribute('role', 'grid');
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    var thCorner = document.createElement('th');
    thCorner.textContent = 'Colore';
    thCorner.className = 'pc-matrix-th-color';
    hr.appendChild(thCorner);
    sizes.forEach(function (s) {
      var th = document.createElement('th');
      th.textContent = sizes.length === 1 ? 'Quantità' : s;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    colors.forEach(function (color) {
      var row = document.createElement('tr');
      var cc = document.createElement('th');
      cc.className = 'pc-matrix-color-cell';
      var swatchStyle = swatchMap[color];
      var swatch = document.createElement('span');
      swatch.className = 'pc-color-swatch';
      applySwatchStyleToEl(swatch, swatchStyle);
      cc.appendChild(swatch);
      var label = document.createElement('span');
      label.className = 'pc-color-label';
      label.textContent = color;
      cc.appendChild(label);
      row.appendChild(cc);
      sizes.forEach(function (size) {
        var td = document.createElement('td');
        var variant = getMatrixVariant(color, size);
        if (!variant) {
          td.className = 'pc-matrix-cell-disabled';
          td.textContent = CONFIG.labels.notAvailable;
        } else if (!variant.available) {
          td.className = 'pc-matrix-cell-unavailable';
          td.textContent = CONFIG.labels.unavailable;
        } else {
          var inp = document.createElement('input');
          inp.type = 'number';
          inp.min = '0';
          inp.step = 'any';
          inp.className = 'pc-matrix-qty-input';
          inp.setAttribute('aria-label', color + ' / ' + size);
          inp.dataset.variantId = String(variant.id);
          inp.dataset.color = color;
          inp.dataset.size = size;
          inp.dataset.price = String(getBaseUnitPriceCents(0, state, variant));
          inp.value = state.quantities[String(variant.id)] || 0;
          inp.addEventListener('input', handleQuantityInput);
          inp.addEventListener('change', handleQuantityInput);
          inp.addEventListener('blur', handleQuantityInput);
          td.appendChild(inp);
        }
        row.appendChild(td);
      });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    container.appendChild(table);
    buildMobileMatrixAccordion();
  }

  /** Abbigliamento: +/− di 1. Gadget: +/− = qtyStep (confezione). */
  function getMobileQtyStep() {
    if (isApparelQuantityMode()) return 1;
    if (isQuantityPricingActive() && CONFIG.quantityPricing && CONFIG.quantityPricing.qtyStep) {
      return Math.max(1, parseInt(CONFIG.quantityPricing.qtyStep, 10) || 1);
    }
    return 1;
  }

  function appendMobileQtyControls(parent, variant, color, size, qtyStep) {
    var controls = document.createElement('div');
    controls.className = 'pc-matrix-mobile-qty-controls';
    var minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'pc-matrix-mobile-qty-btn';
    minus.setAttribute('aria-label', 'Diminuisci');
    minus.textContent = '−';
    var inp = document.createElement('input');
    inp.type = 'number';
    inp.min = '0';
    /* step=any: evita popup HTML5 nativo; lo step totale è gestito da snapOrderQuantityToMinStep */
    inp.step = 'any';
    inp.className = 'pc-matrix-qty-input pc-matrix-mobile-qty-input';
    inp.setAttribute('aria-label', size ? (color + ' / ' + size) : ('Quantità ' + color));
    inp.dataset.variantId = String(variant.id);
    inp.dataset.color = color;
    inp.dataset.size = size || '';
    try {
      inp.dataset.price = String(getBaseUnitPriceCents(0, state, variant));
    } catch (errPrice) {
      inp.dataset.price = String(variantPriceCents(variant));
    }
    inp.value = state.quantities[variant.id] || 0;
    var plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'pc-matrix-mobile-qty-btn';
    plus.setAttribute('aria-label', 'Aumenta');
    plus.textContent = '+';
    function updateQty(delta) {
      state.lastQtyVariantId = String(variant.id);
      var v = parseInt(inp.value, 10);
      if (isNaN(v)) v = 0;
      v = Math.max(0, v + delta);
      inp.value = v;
      state.quantities[variant.id] = v;
      if (isQuantityPricingActive()) snapOrderQuantityToMinStep({ notify: false });
      updateSummary();
      updateNavButtons();
      updateMobileAccordionQtyBadges();
      syncMatrixInputs();
    }
    minus.addEventListener('click', function (ev) {
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      updateQty(-qtyStep);
    });
    plus.addEventListener('click', function (ev) {
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      updateQty(qtyStep);
    });
    inp.addEventListener('click', function (ev) { if (ev) ev.stopPropagation(); });
    inp.addEventListener('input', handleQuantityInput);
    inp.addEventListener('change', handleQuantityInput);
    inp.addEventListener('blur', handleQuantityInput);
    inp.addEventListener('change', function () { updateMobileAccordionQtyBadges(); syncMatrixInputs(); });
    controls.appendChild(minus);
    controls.appendChild(inp);
    controls.appendChild(plus);
    parent.appendChild(controls);
    return controls;
  }

  function applyColorSwatch(swatchEl, color, swatchMap) {
    applySwatchStyleToEl(swatchEl, swatchMap[color]);
  }

  /** Prodotti solo colore: riga piatta con − / qty / + sempre visibili (niente tendina). */
  function buildMobileColorOnlyList() {
    var container = document.getElementById('pc-matrix-mobile-accordion');
    if (!container) return;
    var colors = state.colorAxis ? state.colorAxis.values : ['—'];
    var swatchMap = getColorSwatchMap();
    var qtyStep = getMobileQtyStep();
    container.innerHTML = '';
    container.classList.add('pc-matrix-mobile-flat');
    colors.forEach(function (color) {
      var row = document.createElement('div');
      row.className = 'pc-matrix-mobile-flat-row';
      row.dataset.color = color;
      var swatch = document.createElement('span');
      swatch.className = 'pc-color-swatch';
      applyColorSwatch(swatch, color, swatchMap);
      row.appendChild(swatch);
      var title = document.createElement('span');
      title.className = 'pc-matrix-mobile-flat-title';
      title.textContent = color;
      row.appendChild(title);
      var variant = getMatrixVariant(color, null);
      if (!variant) {
        var na = document.createElement('span');
        na.className = 'pc-matrix-mobile-unavailable';
        na.textContent = CONFIG.labels.notAvailable;
        row.appendChild(na);
        row.classList.add('pc-disabled');
      } else if (!variant.available) {
        var unav = document.createElement('span');
        unav.className = 'pc-matrix-mobile-unavailable';
        unav.textContent = CONFIG.labels.unavailable;
        row.appendChild(unav);
        row.classList.add('pc-disabled');
      } else {
        pcWarnStock(variant, 'buildMobileColorOnlyList');
        appendMobileQtyControls(row, variant, color, '', qtyStep);
      }
      container.appendChild(row);
    });
  }

  function buildMobileMatrixAccordion() {
    var container = document.getElementById('pc-matrix-mobile-accordion');
    if (!container) return;
    container.classList.remove('pc-matrix-mobile-flat');
    /* Solo colore: niente accordion, stepper inline */
    if (!state.sizeAxis) {
      buildMobileColorOnlyList();
      return;
    }
    var colors = state.colorAxis ? state.colorAxis.values : ['—'];
    var sizes = state.sizeAxis ? state.sizeAxis.values : ['—'];
    var swatchMap = getColorSwatchMap();
    var qtyStep = getMobileQtyStep();
    container.innerHTML = '';
    colors.forEach(function (color, colorIdx) {
      var card = document.createElement('div');
      card.className = 'pc-matrix-mobile-card';
      card.dataset.color = color;
      var qtyForColor = 0;
      sizes.forEach(function (size) {
        var variant = getMatrixVariant(color, size);
        if (variant && state.quantities[variant.id]) qtyForColor += state.quantities[variant.id] || 0;
      });
      var header = document.createElement('button');
      header.type = 'button';
      header.className = 'pc-matrix-mobile-card-header';
      header.setAttribute('aria-expanded', 'false');
      header.setAttribute('aria-controls', 'pc-mobile-accordion-body-' + colorIdx);
      var swatch = document.createElement('span');
      swatch.className = 'pc-color-swatch';
      applyColorSwatch(swatch, color, swatchMap);
      header.appendChild(swatch);
      var title = document.createElement('span');
      title.className = 'pc-matrix-mobile-card-title';
      title.textContent = color;
      header.appendChild(title);
      var qtyWrap = document.createElement('span');
      qtyWrap.className = 'pc-matrix-mobile-card-qty';
      qtyWrap.textContent = 'Qtà';
      var qtyBadge = document.createElement('span');
      qtyBadge.className = 'pc-matrix-mobile-card-qty-badge';
      qtyBadge.textContent = qtyForColor;
      qtyBadge.dataset.colorQty = color;
      qtyWrap.appendChild(document.createTextNode(' '));
      qtyWrap.appendChild(qtyBadge);
      header.appendChild(qtyWrap);
      var caret = document.createElement('span');
      caret.className = 'pc-matrix-mobile-card-caret';
      caret.setAttribute('aria-hidden', 'true');
      caret.textContent = '▼';
      header.appendChild(caret);
      card.appendChild(header);
      var body = document.createElement('div');
      body.id = 'pc-mobile-accordion-body-' + colorIdx;
      body.className = 'pc-matrix-mobile-card-body';
      body.hidden = true;
      sizes.forEach(function (size) {
        var variant = getMatrixVariant(color, size);
        var row = document.createElement('div');
        row.className = 'pc-matrix-mobile-size-row';
        var sizeLabel = document.createElement('span');
        sizeLabel.className = 'pc-matrix-mobile-size-label';
        sizeLabel.textContent = size;
        row.appendChild(sizeLabel);
        if (!variant) {
          var na = document.createElement('span');
          na.className = 'pc-matrix-mobile-unavailable';
          na.textContent = CONFIG.labels.notAvailable;
          row.appendChild(na);
          row.classList.add('pc-disabled');
        } else if (!variant.available) {
          var unav = document.createElement('span');
          unav.className = 'pc-matrix-mobile-unavailable';
          unav.textContent = CONFIG.labels.unavailable;
          row.appendChild(unav);
          row.classList.add('pc-disabled');
        } else {
          var stock = document.createElement('span');
          stock.className = 'pc-matrix-mobile-stock';
          stock.textContent = variant.inventory_quantity != null ? variant.inventory_quantity : '—';
          pcWarnStock(variant, 'buildMobileMatrixAccordion');
          row.appendChild(stock);
          appendMobileQtyControls(row, variant, color, size, qtyStep);
        }
        body.appendChild(row);
      });
      card.appendChild(body);
      header.addEventListener('click', function () {
        var isOpen = card.classList.contains('pc-open');
        if (!isOpen) {
          document.querySelectorAll('.pc-matrix-mobile-card.pc-open').forEach(function (c) {
            if (c !== card) {
              c.classList.remove('pc-open');
              var h = c.querySelector('.pc-matrix-mobile-card-header');
              var b = c.querySelector('.pc-matrix-mobile-card-body');
              if (h) h.setAttribute('aria-expanded', 'false');
              if (b) b.hidden = true;
            }
          });
        }
        isOpen = card.classList.toggle('pc-open');
        header.setAttribute('aria-expanded', isOpen);
        body.hidden = !isOpen;
      });
      container.appendChild(card);
    });
  }

  function updateMobileAccordionQtyBadges() {
    var colors = state.colorAxis ? state.colorAxis.values : ['—'];
    var sizes = state.sizeAxis ? state.sizeAxis.values : ['—'];
    colors.forEach(function (color) {
      var qtyForColor = 0;
      sizes.forEach(function (size) {
        var variant = getMatrixVariant(color, size);
        if (variant) qtyForColor += state.quantities[variant.id] || 0;
      });
      var badge = document.querySelector('.pc-matrix-mobile-card-qty-badge[data-color-qty="' + color + '"]');
      if (badge) badge.textContent = qtyForColor;
    });
  }

  function syncMatrixInputs() {
    var tableInputs = document.querySelectorAll('.pc-matrix-table .pc-matrix-qty-input');
    var mobileInputs = document.querySelectorAll('.pc-matrix-mobile-accordion .pc-matrix-qty-input');
    tableInputs.forEach(function (inp) {
      var vid = inp.dataset.variantId;
      if (vid && state.quantities[vid] != null) inp.value = state.quantities[vid];
    });
    mobileInputs.forEach(function (inp) {
      var vid = inp.dataset.variantId;
      if (vid && state.quantities[vid] != null) inp.value = state.quantities[vid];
    });
  }

  function handleQuantityInput(e) {
    var inp = e.target;
    var vid = inp.dataset.variantId;
    state.lastQtyVariantId = vid;
    var val = parseInt(inp.value, 10);
    if (isNaN(val) || val < 0) val = 0;
    inp.value = val;
    state.quantities[vid] = val;
    if ((e.type === 'change' || e.type === 'blur') && isQuantityPricingActive()) {
      snapOrderQuantityToMinStep({ notify: true });
    }
    updateSummary();
    updateNavButtons();
    if (typeof updateMobileAccordionQtyBadges === 'function') updateMobileAccordionQtyBadges();
    if (typeof syncMatrixInputs === 'function') syncMatrixInputs();
  }

  function getTotalQuantity() {
    return Object.keys(state.quantities).reduce(function (s, vid) { return s + (state.quantities[vid] || 0); }, 0);
  }

  function calculateBaseItemsTotal() {
    var product = state.product;
    if (!product || !product.variants || !Array.isArray(product.variants)) return 0;
    if (isQuantityPricingActive()) return getQuantityPricingMerchandiseTotalCents();
    var t = 0;
    Object.keys(state.quantities).forEach(function (vid) {
      var q = state.quantities[vid] || 0;
      if (q <= 0) return;
      var v = product.variants.find(function (x) { return String(x.id) === vid; });
      if (v) t += getBaseUnitPriceCents(q, state, v) * q;
    });
    return t;
  }

  function calculatePersonalizationSurchargeCents() {
    return calculateMetaPersonalizationSurchargeCents();
  }

  function calculatePrintOptionsTotal() {
    return calculatePersonalizationSurchargeCents();
  }

  function calculateGrandTotal() {
    return calculateBaseItemsTotal() + calculatePrintOptionsTotal();
  }

  function updateSummary() {
    var itemsEl = document.getElementById('pc-summary-items');
    var product = state.product;
    if (!product || !itemsEl || !product.variants) return;
    var qpActive = isQuantityPricingActive();
    var snap = getQuantityPricingSnapshot();
    var qpLineMerch = qpActive ? getQuantityPricingLineMerchCentsMap() : null;
    var lines = [];
    Object.keys(state.quantities).forEach(function (vid) {
      var q = state.quantities[vid];
      if (q <= 0) return;
      var v = product.variants.find(function (x) { return String(x.id) === vid; });
      if (v) {
        var opts = [v.option1, v.option2, v.option3].filter(Boolean);
        var norm = variantPriceCents(v);
        var rowCents = computeSummaryLineTotalCents(qpActive, vid, q, qpLineMerch, norm);
        pcWarnSummaryRow('updateSummary', {
          function: 'updateSummary',
          variantId: v.id,
          variantTitle: v.title != null ? v.title : v.name,
          rawVariantPrice: v.price,
          normalizedVariantPriceCents: norm,
          quantity: q,
          lineTotalCents: rowCents,
          lineTotalFormatted: formatMoney(rowCents),
          CONFIGquantityPricing: CONFIG.quantityPricing,
          quantityPricingActive: qpActive,
          merchMapBranch: qpLineMerch ? qpLineMerch[vid] : null
        });
        lines.push({
          text: opts.join(' / ') + ' × ' + q,
          rowCents: rowCents
        });
      }
    });
    if (lines.length === 0) {
      itemsEl.innerHTML = '<p class="pc-summary-empty" id="pc-summary-empty">Seleziona quantità nello step 1</p>';
    } else {
      itemsEl.innerHTML = '';
      lines.forEach(function (l) {
        var d = document.createElement('div');
        d.className = 'pc-summary-line';
        d.textContent = l.text + ' — ' + formatMoney(l.rowCents);
        itemsEl.appendChild(d);
      });
    }
    var mb = document.getElementById('pc-summary-merch-block');
    if (mb) {
      mb.innerHTML = '';
      var tqMerch = getTotalQuantity();
      if (tqMerch > 0 && snap && isQuantityPricingActive()) {
        mb.hidden = false;
        mb.classList.remove('pc-hidden');
        mb.removeAttribute('hidden');
        var mh = document.createElement('div');
        mh.className = 'pc-summary-merch-heading';
        mh.textContent = 'MERCE';
        mb.appendChild(mh);
        function addMerchRow(label, valueText) {
          var r = document.createElement('div');
          r.className = 'pc-summary-merch-row';
          var la = document.createElement('span');
          la.textContent = label;
          var va = document.createElement('span');
          va.className = 'pc-price';
          va.textContent = valueText;
          r.appendChild(la);
          r.appendChild(va);
          mb.appendChild(r);
        }
        addMerchRow('Quantità totale', String(snap.qty));
        addMerchRow('Prezzo unitario base', formatMoney(snap.baseUnitCents));
        addMerchRow('Sconto quantità', snap.discountPercent > 0 ? '−' + snap.discountPercent + '%' : '—');
        addMerchRow('Totale merce', formatMoney(snap.merchandiseCents));
      } else if (tqMerch > 0) {
        mb.hidden = false;
        mb.classList.remove('pc-hidden');
        mb.removeAttribute('hidden');
        var mh0 = document.createElement('div');
        mh0.className = 'pc-summary-merch-heading';
        mh0.textContent = 'MERCE';
        mb.appendChild(mh0);
        var r0 = document.createElement('div');
        r0.className = 'pc-summary-merch-row';
        var l0 = document.createElement('span');
        l0.textContent = 'Quantità totale';
        var v0 = document.createElement('span');
        v0.className = 'pc-price';
        v0.textContent = String(tqMerch);
        r0.appendChild(l0);
        r0.appendChild(v0);
        mb.appendChild(r0);
        var r1 = document.createElement('div');
        r1.className = 'pc-summary-merch-row';
        var l1 = document.createElement('span');
        l1.textContent = 'Totale merce';
        var v1 = document.createElement('span');
        v1.className = 'pc-price';
        v1.textContent = formatMoney(calculateBaseItemsTotal());
        r1.appendChild(l1);
        r1.appendChild(v1);
        mb.appendChild(r1);
      } else {
        mb.innerHTML = '';
        mb.hidden = true;
        mb.classList.add('pc-hidden');
        mb.setAttribute('hidden', '');
      }
    }
    var persBox = document.getElementById('pc-summary-personalization');
    if (persBox) {
      persBox.innerHTML = '';
      persBox.hidden = true;
      if (isAwardsPersMode()) {
        var awardsFilled = getFilledAwardsLabels();
        if (awardsFilled.length > 0) {
          persBox.hidden = false;
          var ah = document.createElement('div');
          ah.className = 'pc-summary-pers-heading';
          ah.textContent = 'ETICHETTE';
          persBox.appendChild(ah);
          awardsFilled.forEach(function (row) {
            var ar = document.createElement('div');
            ar.className = 'pc-summary-pers-line';
            ar.textContent = row.label + ': ' + row.text;
            persBox.appendChild(ar);
          });
        }
      } else if (usesMetaPersonalization()) {
        var pDetails = getPersonalizationLineDetails();
        if (pDetails.length > 0) {
          persBox.hidden = false;
          var ph = document.createElement('div');
          ph.className = 'pc-summary-pers-heading';
          ph.textContent = 'PERSONALIZZAZIONI';
          persBox.appendChild(ph);
          pDetails.forEach(function (d) {
            var pr = document.createElement('div');
            pr.className = 'pc-summary-pers-line';
            pr.textContent =
              d.coveredByVariant
                ? d.cents > 0
                  ? d.label + ' → +' + formatMoney(d.cents)
                  : d.label + ' → Incluso nel listino'
                : d.percentage <= 0 && d.cents <= 0
                  ? d.label + ' → 0% → Incluso'
                  : d.label + ' → +' + d.percentage + '% → +' + formatMoney(d.cents);
            persBox.appendChild(pr);
          });
          var pTot = pDetails.reduce(function (a, b) {
            return a + b.cents;
          }, 0);
          var ptEl = document.createElement('div');
          ptEl.className = 'pc-summary-pers-total';
          ptEl.textContent = 'Totale personalizzazioni: +' + formatMoney(pTot);
          persBox.appendChild(ptEl);
        }
      }
    }
    var qd = document.getElementById('pc-qty-pricing-detail');
    if (qd) {
      if (snap && isQuantityPricingActive()) {
        qd.classList.remove('pc-hidden');
        var uList = document.getElementById('pc-qp-unit-list');
        var uDisc = document.getElementById('pc-qp-discount-pct');
        var uNet = document.getElementById('pc-qp-unit-net');
        if (uList) uList.textContent = formatMoney(snap.baseUnitCents);
        if (uDisc) uDisc.textContent = snap.discountPercent > 0 ? String(snap.discountPercent) + '%' : '—';
        if (uNet) uNet.textContent = formatEuroUnitAverage(snap.merchandiseCents, snap.qty);
      } else {
        qd.classList.add('pc-hidden');
      }
    }
    var qv = document.getElementById('pc-total-qty-value');
    if (qv) qv.textContent = getTotalQuantity();
    var tb = document.getElementById('pc-total-base');
    if (tb) tb.textContent = formatMoney(calculateBaseItemsTotal());
    var tp = document.getElementById('pc-total-print');
    if (tp) tp.textContent = formatMoney(calculatePrintOptionsTotal());
    var tg = document.getElementById('pc-total-grand');
    if (tg) tg.textContent = formatMoney(calculateGrandTotal());
    /* Sync valori barra compatta mobile */
    var mq = document.getElementById('pc-mobile-qty');
    var mg = document.getElementById('pc-mobile-grand');
    if (mq) mq.textContent = getTotalQuantity();
    if (mg) mg.textContent = formatMoney(calculateGrandTotal());
    if (PC_DEBUG && isQuantityPricingActive()) {
      var tqD = getTotalQuantity();
      dbg('QTY', { totalQty: tqD, basePriceCents: CONFIG.quantityPricing.basePriceCents });
      dbg('DISCOUNT', {
        discountPercent: resolveDiscountPercentFromTiers(tqD, CONFIG.quantityPricing.tiers),
        tiers: CONFIG.quantityPricing.tiers
      });
      dbg('TOTAL', {
        merchandise: calculateBaseItemsTotal(),
        personalization: calculatePrintOptionsTotal(),
        grand: calculateGrandTotal()
      });
    }
    if (PC_DEBUG) dbg('PERSONALIZATION', getPersonalizationLineDetails());
    refreshMetaPersCardPrices();
  }

  function renderQuantityTiersFromConfig() {
    var wrap = document.getElementById('pc-quantity-tiers');
    if (!wrap) return;
    var h4 = wrap.querySelector('h4');
    wrap.innerHTML = '';
    if (h4) wrap.appendChild(h4);
    else {
      var nh = document.createElement('h4');
      nh.textContent = 'Sconti quantità';
      wrap.appendChild(nh);
    }
    if (!isQuantityPricingActive()) {
      var p = document.createElement('p');
      p.className = 'pc-quantity-tiers-placeholder';
      p.textContent = 'Prezzi da listino variante (nessuno sconto quantità configurato).';
      wrap.appendChild(p);
      return;
    }
    var qp = CONFIG.quantityPricing;
    var tiers = (qp.tiers || []).slice().sort(function (a, b) {
      return a.minQty - b.minQty;
    });
    var baseEuro = (qp.basePriceCents || 0) / 100;
    tiers.forEach(function (t) {
      var row = document.createElement('div');
      row.className = 'pc-quantity-tier';
      var span = document.createElement('span');
      span.textContent = 'Da ' + t.minQty + ' pz';
      var strong = document.createElement('strong');
      if (t.discountPercent > 0) {
        strong.textContent = '−' + t.discountPercent + '% · listino ' + baseEuro.toFixed(2).replace('.', ',') + ' € cad.';
      } else {
        strong.textContent = baseEuro.toFixed(2).replace('.', ',') + ' € cad.';
      }
      row.appendChild(span);
      row.appendChild(strong);
      wrap.appendChild(row);
    });
  }

  function formatEuroItFromCents(cents) {
    var n = (Number(cents) || 0) / 100;
    return '€ ' + n.toFixed(2).replace('.', ',');
  }

  function addBusinessDays(fromDate, days) {
    var d = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
    var left = Math.max(0, parseInt(days, 10) || 0);
    while (left > 0) {
      d.setDate(d.getDate() + 1);
      var wd = d.getDay();
      if (wd !== 0 && wd !== 6) left -= 1;
    }
    return d;
  }

  function formatItDate(d) {
    var dd = String(d.getDate()).padStart(2, '0');
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    return dd + '/' + mm + '/' + d.getFullYear();
  }

  function renderPdpDeliveryEta() {
    var root = document.getElementById('pc-pdp-gedshop');
    if (!root) return;
    var std = parseInt(root.getAttribute('data-standard-days'), 10);
    var exp = parseInt(root.getAttribute('data-express-days'), 10);
    if (isNaN(std)) std = 5;
    if (isNaN(exp)) exp = 2;
    var now = new Date();
    var elStd = document.getElementById('pc-pdp-eta-standard');
    var elExp = document.getElementById('pc-pdp-eta-express');
    if (elStd) elStd.textContent = formatItDate(addBusinessDays(now, std));
    if (elExp) elExp.textContent = formatItDate(addBusinessDays(now, exp));
  }

  function collectPdpTierRows() {
    var rows = [];
    var p = state.product || {};
    var raw = p.quantityPricing;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch (e) {
        raw = null;
      }
    }
    if (raw && Array.isArray(raw.qtyTable)) {
      raw.qtyTable.forEach(function (r) {
        if (!r || r.minQty == null || r.unitPriceCents == null) return;
        var q = parseInt(r.minQty, 10);
        var c = parseInt(r.unitPriceCents, 10);
        if (!isNaN(q) && !isNaN(c)) rows.push({ qty: q, unitCents: c });
      });
    }
    if (!rows.length) {
      var base = 0;
      var tiers = [];
      if (isQuantityPricingActive()) {
        base = CONFIG.quantityPricing.basePriceCents || 0;
        tiers = CONFIG.quantityPricing.tiers || [];
      } else if (raw && typeof raw === 'object') {
        var hasBase = raw.basePrice != null || raw.baseUnitPrice != null;
        if (hasBase) {
          base = centsFromMetafieldEuroField(raw.basePrice != null ? raw.basePrice : raw.baseUnitPrice);
          tiers = normalizeDiscountTiersLocal(raw.discountTiers);
        }
      }
      tiers
        .slice()
        .sort(function (a, b) {
          return a.minQty - b.minQty;
        })
        .forEach(function (t) {
          var disc = Number(t.discountPercent) || 0;
          var unit = shopifyNetUnitCents(base, disc);
          rows.push({ qty: t.minQty, unitCents: unit });
        });
    }
    rows.sort(function (a, b) {
      return a.qty - b.qty;
    });
    return rows;
  }

  /** Prezzo "da" PDP: unitario più basso tra fasce qty e prezzi variante. */
  function getPdpPriceFromCents() {
    var minCents = null;
    collectPdpTierRows().forEach(function (r) {
      if (!r || r.unitCents == null || isNaN(r.unitCents)) return;
      if (minCents == null || r.unitCents < minCents) minCents = r.unitCents;
    });
    var variants = (state.product && state.product.variants) || [];
    for (var i = 0; i < variants.length; i++) {
      var c = centsFromShopifyVariantPrice(variants[i] && variants[i].price);
      if (c > 0 && (minCents == null || c < minCents)) minCents = c;
    }
    return minCents;
  }

  function updatePdpPriceFromCard() {
    var el = document.querySelector('.pc-pdp-price-card-value');
    if (!el) return;
    var cents = getPdpPriceFromCents();
    if (cents == null || isNaN(cents) || cents < 0) return;
    el.textContent = formatEuroItFromCents(cents).replace(/^€\s*/, '€');
  }

  function renderPdpTierBoxes() {
    var boxes = document.getElementById('pc-pdp-tier-boxes');
    var wrap = document.getElementById('pc-pdp-tiers');
    if (!boxes) return;
    var rows = collectPdpTierRows().slice(0, 3);
    boxes.innerHTML = '';
    if (!rows.length) {
      if (wrap) wrap.hidden = true;
      return;
    }
    if (wrap) wrap.hidden = false;
    rows.forEach(function (r) {
      var box = document.createElement('div');
      box.className = 'pc-pdp-tier-box';
      box.innerHTML =
        '<span>' +
        r.qty +
        ' pezzi</span><strong>' +
        formatEuroItFromCents(r.unitCents) +
        '</strong>';
      boxes.appendChild(box);
    });
  }

  function hideYmqProductOptions() {
    if (!window.__PC_HIDE_YMQ && !document.documentElement.classList.contains('pc-hide-ymq')) {
      if (!document.getElementById('pc-configurator')) return;
      document.documentElement.classList.add('pc-hide-ymq');
      window.__PC_HIDE_YMQ = true;
    }
    if (!window.__PC_HIDE_YMQ) return;
    try {
      if (window.ymq_option) {
        window.ymq_option.ymq_status = window.ymq_option.ymq_status || {};
        window.ymq_option.ymq_status.ymq_status = '0';
      }
    } catch (e) {}
    var nodes = document.querySelectorAll(
      '#ymq-box, .ymq-box, .ymq-options-box, .ymq-options, #ymq-options, [id^="option-box-"], .ymq-upload-box, .ymq-product-options, .ymq-option, .ymq-option-box, .ymq-options-wrapper, .ymq-app, #ymq_drag'
    );
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el || el === document.documentElement || el === document.body) continue;
      if (el.tagName === 'HTML' || el.tagName === 'BODY' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'LINK') continue;
      el.style.setProperty('display', 'none', 'important');
      el.setAttribute('hidden', '');
      el.setAttribute('aria-hidden', 'true');
    }
  }

  function initHideYmqProductOptions() {
    hideYmqProductOptions();
    if (window.__PC_YMQ_OBSERVER) return;
    try {
      var obs = new MutationObserver(function () {
        hideYmqProductOptions();
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      window.__PC_YMQ_OBSERVER = obs;
    } catch (e) {}
    setTimeout(hideYmqProductOptions, 0);
    setTimeout(hideYmqProductOptions, 500);
    setTimeout(hideYmqProductOptions, 1500);
  }

  function initPdpGedshopStrip() {
    updatePdpPriceFromCard();
    renderPdpTierBoxes();
    initHideYmqProductOptions();
  }

  function initAuxiliaryUi() {
    renderQuantityTiersFromConfig();
    initPersonalizationFromProduct();
    initPdpGedshopStrip();
  }

  function renderDeliveryNotesFromConfig() {
    var notes = (CONFIG && CONFIG.deliveryNotes) || [];
    var container = document.getElementById('pc-delivery-notes');
    if (!container || !notes.length) return;
    container.hidden = false;
    container.innerHTML = '';
    notes
      .slice()
      .sort(function (a, b) {
        return (a.sortOrder || 0) - (b.sortOrder || 0);
      })
      .forEach(function (n) {
        var div = document.createElement('div');
        div.className = 'pc-delivery-note';
        var title = document.createElement('div');
        title.className = 'pc-delivery-note-title';
        title.textContent = n.title || '';
        var body = document.createElement('div');
        body.className = 'pc-delivery-note-content';
        body.textContent = n.content || '';
        div.appendChild(title);
        div.appendChild(body);
        container.appendChild(div);
      });
  }

  function initOptionalServices() {}

  function formatFileSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function getUploadMaxBytes() {
    var max = CONFIG && CONFIG.uploadMaxBytes;
    return typeof max === 'number' && max > 0 ? max : 20 * 1024 * 1024;
  }

  function nextUploadId() {
    return 'f' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function initFileUpload() {
    var inp = document.getElementById('pc-file-input');
    var zone = document.getElementById('pc-upload-zone');
    var list = document.getElementById('pc-file-list');
    var sl = document.getElementById('pc-send-later');
    if (!inp || !zone || !list) return;

    function addFile(file) {
      if (!file || !file.name) return;
      var maxBytes = getUploadMaxBytes();
      if (file.size > maxBytes) {
        showMessage(
          'File troppo grande (max ' + formatFileSize(maxBytes) + '): ' + file.name,
          'error'
        );
        return;
      }
      var entry = { id: nextUploadId(), file: file };
      state.files.push(entry);
      var li = document.createElement('li');
      li.dataset.fileId = entry.id;
      li.appendChild(document.createTextNode(file.name + ' (' + formatFileSize(file.size) + ') '));
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pc-file-remove';
      btn.textContent = 'Rimuovi';
      btn.addEventListener('click', function () {
        state.files = state.files.filter(function (f) { return f.id !== entry.id; });
        li.remove();
      });
      li.appendChild(btn);
      list.appendChild(li);
    }

    inp.addEventListener('change', function () {
      Array.prototype.forEach.call(inp.files || [], addFile);
      inp.value = '';
    });
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('pc-dragover'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('pc-dragover'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('pc-dragover');
      Array.prototype.forEach.call(e.dataTransfer.files || [], addFile);
    });
    if (sl) {
      sl.addEventListener('change', function () {
        state.sendLater = sl.checked;
        syncNoFileNotesRequirement();
      });
      syncNoFileNotesRequirement();
    }
  }

  function getPrintNotesValue() {
    var notes = document.getElementById('pc-print-notes');
    return notes && notes.value ? notes.value.trim() : '';
  }

  function syncNoFileNotesRequirement() {
    var sl = document.getElementById('pc-send-later');
    var notes = document.getElementById('pc-print-notes');
    var field = document.getElementById('pc-graphic-instructions');
    var required = !!(sl && sl.checked);
    if (notes) {
      if (required) notes.setAttribute('required', 'required');
      else notes.removeAttribute('required');
      notes.setAttribute('aria-required', required ? 'true' : 'false');
    }
    if (field) field.classList.toggle('pc-notes-required', required);
  }

  function getStep3ValidationMessage() {
    if (isAwardsPersMode()) return '';
    var sl = document.getElementById('pc-send-later');
    if (sl && sl.checked) {
      if (!getPrintNotesValue()) {
        return 'Compila il campo sottostante per le istruzioni ai nostri grafici per realizzare la grafica.';
      }
      return '';
    }
    if (state.files.length > 0) return '';
    return 'Carica almeno un file o seleziona "Non ho un file.".';
  }

  function validateStep(step) {
    switch (step) {
      case 1:
        if (isQuantityPricingActive()) snapOrderQuantityToMinStep();
        if (getTotalQuantity() <= 0) return false;
        if (!validateQuantityPricingRules()) return false;
        return step1ApparelMinOrderBlockReason() === null;
      case 2:
        if (isAwardsPersMode()) return countFilledAwardsLabels() >= 1;
        if (!usesMetaPersonalization()) return true;
        if (isClothingPersMode()) return true;
        return hasSelectedGeneralPersonalization();
      case 3:
        return !getStep3ValidationMessage();
      case 4:
        return true;
      default: return true;
    }
  }

  function updateFooterButtons() {
    var step = state.currentStep;
    var totalSteps = state.totalSteps || 4;
    var isLastStep = step >= totalSteps;
    var isFirstStep = step <= 1;
    var prevBtn = document.getElementById('pc-btn-prev');
    var nextBtn = document.getElementById('pc-btn-next');
    var addBtn = document.getElementById('pc-btn-add-cart');
    if (prevBtn) {
      prevBtn.disabled = isFirstStep;
    }
    if (nextBtn) {
      if (isLastStep) {
        nextBtn.setAttribute('hidden', '');
      } else {
        nextBtn.removeAttribute('hidden');
      }
      var firstCta = isAwardsPersMode() ? 'Passa alle Etichette' : 'Passa alla Personalizzazione';
      nextBtn.textContent = isFirstStep ? firstCta : 'Avanti';
      nextBtn.setAttribute('aria-label', isFirstStep ? firstCta : 'Prosegui');
      nextBtn.disabled = isFirstStep && getTotalQuantity() === 0;
    }
    if (addBtn) {
      if (isLastStep) {
        addBtn.removeAttribute('hidden');
      } else {
        addBtn.setAttribute('hidden', '');
      }
    }
  }

  function goToStep(step) {
    state.currentStep = step;
    document.querySelectorAll('.pc-step-tab').forEach(function (tab) {
      var s = parseInt(tab.dataset.step, 10);
      tab.classList.toggle('pc-active', s === step);
      tab.setAttribute('aria-selected', s === step);
    });
    document.querySelectorAll('.pc-step-panel').forEach(function (panel) {
      var s = parseInt(panel.dataset.step, 10);
      var active = s === step;
      panel.classList.toggle('pc-active', active);
      panel.hidden = !active;
    });
    updateFooterButtons();
    if (step === 4) renderFinalSummary();
    updateNavButtons();
    updateMobileSummaryVisibility(step);
    updateMobileStepHeader(step);
  }

  function mergeMobileStepTitles(overrides) {
    var base = { 1: 'Taglie e colori', 2: 'Personalizzazione', 3: 'File e note', 4: 'Riepilogo' };
    if (!overrides || typeof overrides !== 'object') return base;
    Object.keys(overrides).forEach(function (k) {
      var n = parseInt(k, 10);
      if (!isNaN(n) && overrides[k]) base[n] = overrides[k];
    });
    return base;
  }

  var MOBILE_STEP_TITLES = mergeMobileStepTitles(null);

  function updateMobileStepHeader(step) {
    var totalSteps = state.totalSteps || 4;
    var titleEl = document.getElementById('pc-mobile-step-title');
    var indexEl = document.getElementById('pc-mobile-step-index');
    var fillEl = document.getElementById('pc-mobile-progress-fill');
    var barEl = document.querySelector('.pc-mobile-progress-bar');
    if (titleEl) titleEl.textContent = MOBILE_STEP_TITLES[step] || '';
    if (indexEl) indexEl.textContent = step + '/' + totalSteps;
    var pct = totalSteps > 0 ? Math.round((step / totalSteps) * 100) : 0;
    if (fillEl) {
      fillEl.style.width = pct + '%';
      fillEl.setAttribute('aria-valuenow', step);
    }
    if (barEl) {
      barEl.setAttribute('aria-valuenow', step);
      barEl.setAttribute('aria-valuemax', String(totalSteps));
    }
  }

  /** Mobile wizard: step 1-3 = barra compatta, step 4 = riepilogo completo */
  function updateMobileSummaryVisibility(step) {
    var isMobile = window.matchMedia('(max-width: 767px)').matches;
    if (!isMobile) return;
    var summaryCol = document.querySelector('.pc-summary-column');
    var mobileBar = document.getElementById('pc-mobile-summary-bar');
    var mobileDetail = document.getElementById('pc-mobile-summary-detail');
    var modalBody = document.querySelector('.pc-modal-body');
    if (!summaryCol || !modalBody) return;
    if (step === 4) {
      summaryCol.classList.add('pc-mobile-step-4');
      if (mobileBar) mobileBar.classList.add('pc-hidden');
      if (mobileDetail) {
        mobileDetail.classList.add('pc-open');
        mobileDetail.classList.remove('pc-mobile-detail-collapsed');
      }
      modalBody.classList.add('pc-mobile-step-4');
    } else {
      summaryCol.classList.remove('pc-mobile-step-4');
      if (mobileBar) mobileBar.classList.remove('pc-hidden');
      if (mobileDetail) {
        mobileDetail.classList.remove('pc-open');
        mobileDetail.classList.add('pc-mobile-detail-collapsed');
      }
      modalBody.classList.remove('pc-mobile-step-4');
    }
  }

  function nextStep() {
    if (state.currentStep < state.totalSteps) {
      if (!validateStep(state.currentStep)) {
        if (state.currentStep === 1) {
          if (getQuantityPricingValidationMessage()) {
            return;
          }
          if (getTotalQuantity() <= 0) {
            showMessage('Seleziona almeno una quantità per continuare.', 'error');
            return;
          }
          var moReason = step1ApparelMinOrderBlockReason();
          if (moReason) {
            showMessage(moReason, 'error');
            return;
          }
        }
        if (state.currentStep === 2 && isAwardsPersMode() && countFilledAwardsLabels() < 1) {
          showMessage('Inserisci almeno un’etichetta.', 'error');
          return;
        }
        if (
          state.currentStep === 2 &&
          usesMetaPersonalization() &&
          !isClothingPersMode() &&
          !hasSelectedGeneralPersonalization()
        ) {
          showMessage('Seleziona almeno un\'opzione di personalizzazione.', 'error');
          return;
        }
        if (state.currentStep === 3) {
          showMessage(getStep3ValidationMessage() || 'Completa i campi obbligatori prima di procedere.', 'error');
          return;
        }
        showMessage('Completa i campi obbligatori prima di procedere.', 'error');
        return;
      }
      clearMessage();
      goToStep(state.currentStep + 1);
    }
  }

  function prevStep() {
    if (state.currentStep > 1) { clearMessage(); goToStep(state.currentStep - 1); }
  }

  function updateNavButtons() {
    updateFooterButtons();
  }

  function renderFinalSummary() {
    var el = document.getElementById('pc-final-summary');
    var product = state.product;
    if (!el || !product || !product.variants) return;
    var qpActive = isQuantityPricingActive();
    var snap = getQuantityPricingSnapshot();
    var qpLineMerch = qpActive ? getQuantityPricingLineMerchCentsMap() : null;
    var lines = [];
    Object.keys(state.quantities).forEach(function (vid) {
      var q = state.quantities[vid] || 0;
      if (q <= 0) return;
      var v = product.variants.find(function (x) { return String(x.id) === vid; });
      if (v) {
        var norm = variantPriceCents(v);
        var rowCents = computeSummaryLineTotalCents(qpActive, vid, q, qpLineMerch, norm);
        pcWarnSummaryRow('renderFinalSummary', {
          function: 'renderFinalSummary',
          variantId: v.id,
          variantTitle: v.title != null ? v.title : v.name,
          rawVariantPrice: v.price,
          normalizedVariantPriceCents: norm,
          quantity: q,
          lineTotalCents: rowCents,
          lineTotalFormatted: formatMoney(rowCents),
          CONFIGquantityPricing: CONFIG.quantityPricing,
          quantityPricingActive: qpActive,
          merchMapBranch: qpLineMerch ? qpLineMerch[vid] : null
        });
        lines.push({
          variant: [v.option1, v.option2, v.option3].filter(Boolean).join(' / '),
          qty: q,
          rowCents: rowCents
        });
      }
    });
    var tq = getTotalQuantity();
    var html = '<div class="pc-final-summary-inner">';
    html += '<div class="pc-final-section"><h4 class="pc-final-section-title">MERCE</h4>';
    if (snap && isQuantityPricingActive()) {
      html += '<div class="pc-final-merch-line">Quantità totale: <strong>' + snap.qty + '</strong></div>';
      html += '<div class="pc-final-merch-line">Prezzo unitario base: <strong>' + formatMoney(snap.baseUnitCents) + '</strong></div>';
      html +=
        '<div class="pc-final-merch-line">Sconto quantità: <strong>' +
        (snap.discountPercent > 0 ? '−' + snap.discountPercent + '%' : '—') +
        '</strong></div>';
      html += '<div class="pc-final-merch-line">Totale merce: <strong>' + formatMoney(snap.merchandiseCents) + '</strong></div>';
    } else if (tq > 0) {
      html += '<div class="pc-final-merch-line">Quantità totale: <strong>' + tq + '</strong></div>';
      html +=
        '<div class="pc-final-merch-line">Totale merce: <strong>' +
        formatMoney(calculateBaseItemsTotal()) +
        '</strong></div>';
    }
    html += '</div>';
    html += '<table class="pc-final-summary-table"><thead><tr><th>Variante</th><th>Qtà</th><th>Prezzo</th></tr></thead><tbody>';
    lines.forEach(function (l) {
      html +=
        '<tr><td>' +
        escapeHtml(l.variant) +
        '</td><td>' +
        l.qty +
        '</td><td class="pc-final-price">' +
        formatMoney(l.rowCents) +
        '</td></tr>';
    });
    html += '</tbody></table>';
    if (isAwardsPersMode()) {
      html += '<div class="pc-final-section"><h4 class="pc-final-section-title">ETICHETTE</h4>';
      var awardsRows = getFilledAwardsLabels();
      if (!awardsRows.length) {
        html += '<p class="pc-final-muted">Nessuna etichetta inserita.</p>';
      } else {
        awardsRows.forEach(function (row) {
          html +=
            '<div class="pc-final-pers-line">' +
            escapeHtml(row.label) +
            ': ' +
            escapeHtml(row.text) +
            '</div>';
        });
      }
      html += '</div>';
    } else {
      html += '<div class="pc-final-section"><h4 class="pc-final-section-title">PERSONALIZZAZIONI</h4>';
      var det = getPersonalizationLineDetails();
      if (!det.length) {
        html += '<p class="pc-final-muted">Nessuna personalizzazione selezionata.</p>';
      } else {
        det.forEach(function (d) {
          var line = d.coveredByVariant
            ? d.cents > 0
              ? escapeHtml(d.label) + ' → +' + formatMoney(d.cents)
              : escapeHtml(d.label) + ' → Incluso nel listino'
            : d.percentage <= 0 && d.cents <= 0
              ? escapeHtml(d.label) + ' → 0% → Incluso'
              : escapeHtml(d.label) + ' → +' + d.percentage + '% → +' + formatMoney(d.cents);
          html += '<div class="pc-final-pers-line">' + line + '</div>';
        });
      }
      html +=
        '<div class="pc-final-pers-total">Totale personalizzazioni: <strong>' +
        formatMoney(calculatePrintOptionsTotal()) +
        '</strong></div></div>';
    }
    html += '<div class="pc-final-section"><h4 class="pc-final-section-title">TOTALE</h4>';
    html += '<div class="pc-final-total-row">Totale merce <span>' + formatMoney(calculateBaseItemsTotal()) + '</span></div>';
    html +=
      '<div class="pc-final-total-row">Totale personalizzazioni <span>' +
      formatMoney(calculatePrintOptionsTotal()) +
      '</span></div>';
    html +=
      '<div class="pc-final-grand-wrap"><span class="pc-final-grand-label">Totale finale</span><span class="pc-final-grand-value">' +
      formatMoney(calculateGrandTotal()) +
      '</span> <span class="pc-vat-hint">iva incl.</span></div>';
    html += '</div></div>';
    el.innerHTML = html;
  }

  var PROP_MAX_LEN = 100;
  var PROP_MAX_LEN_CODES = 500;
  /* Note stampa: chunk generosi (già usiamo 500 altrove) + parti multiple = fino a 5000 caratteri */
  var PROP_MAX_LEN_NOTES = 1000;
  var PROP_NOTES_MAX_PARTS = 5;

  function sanitizePropertyValue(val) {
    var s = val === null || val === undefined ? '' : String(val);
    if (s.length > PROP_MAX_LEN) s = s.substring(0, PROP_MAX_LEN) + '…';
    return s;
  }

  function sanitizePropertyValueCodes(val) {
    var s = val === null || val === undefined ? '' : String(val);
    if (s.length > PROP_MAX_LEN_CODES) s = s.substring(0, PROP_MAX_LEN_CODES) + '…';
    return s;
  }

  /** Assegna le note stampa senza troncarle a 100: spezza su più property se necessario. */
  function assignPrintNotesProperties(p, notesVal) {
    if (!notesVal || !p) return;
    var s = String(notesVal);
    var maxTotal = PROP_MAX_LEN_NOTES * PROP_NOTES_MAX_PARTS;
    if (s.length > maxTotal) s = s.substring(0, maxTotal);
    var part = 0;
    for (var i = 0; i < s.length && part < PROP_NOTES_MAX_PARTS; i += PROP_MAX_LEN_NOTES, part++) {
      var key = part === 0 ? 'Note stampa' : 'Note stampa (' + (part + 1) + ')';
      p[key] = s.substring(i, i + PROP_MAX_LEN_NOTES);
    }
  }

  function collectSharedLineItemProperties() {
    var p = {};
    if (!CONFIG) return p;
    var tq = getTotalQuantity();
    p['_Configuratore'] = 'Sì';
    p['_Quantità totale'] = String(tq);
    var qpSnap = getQuantityPricingSnapshot();
    if (qpSnap) {
      p['_Prezzo unitario base'] = sanitizePropertyValue(formatMoney(qpSnap.baseUnitCents));
      p['_Sconto quantità'] = sanitizePropertyValue(qpSnap.discountPercent > 0 ? '-' + qpSnap.discountPercent + '%' : '0%');
      p['_Totale merce'] = sanitizePropertyValue(formatMoney(qpSnap.merchandiseCents));
      var fasce = (CONFIG.quantityPricing.tiers || [])
        .filter(function (t) { return t && t.discountPercent > 0 && t.minQty > 0; })
        .map(function (t) { return t.minQty + ':' + t.discountPercent; })
        .join(',');
      if (fasce) p['_Fasce sconto'] = fasce;
    } else if (tq > 0) {
      var merch = calculateBaseItemsTotal();
      p['_Prezzo unitario base'] = sanitizePropertyValue(formatEuroUnitAverage(merch, tq));
      p['_Sconto quantità'] = sanitizePropertyValue('—');
      p['_Totale merce'] = sanitizePropertyValue(formatMoney(merch));
    } else {
      p['_Prezzo unitario base'] = sanitizePropertyValue('—');
      p['_Sconto quantità'] = sanitizePropertyValue('—');
      p['_Totale merce'] = sanitizePropertyValue(formatMoney(0));
    }
    if (isAwardsPersMode()) {
      var awardsFilled = getFilledAwardsLabels();
      awardsFilled.forEach(function (row) {
        p[row.label] = sanitizePropertyValue(row.text);
      });
      p['_Etichette compilate'] = String(awardsFilled.length);
      p['_Personalizzazioni'] = sanitizePropertyValue(
        awardsFilled.length ? awardsFilled.map(function (r) { return r.label; }).join(', ') : 'Nessuna'
      );
      p['_Dettaglio personalizzazioni'] = sanitizePropertyValueCodes(
        awardsFilled.length
          ? awardsFilled.map(function (r) { return r.label + ': ' + r.text; }).join(' | ')
          : '—'
      );
      p['_Totale personalizzazioni'] = sanitizePropertyValue(formatMoney(0));
    } else {
      var det = getPersonalizationLineDetails();
      if (det.length > 0) {
        p['_Personalizzazioni'] = sanitizePropertyValue(det.map(function (d) { return d.label; }).join(', '));
        p['Personalizzazione'] = sanitizePropertyValue(det.map(function (d) { return d.label; }).join(', '));
        p['_Dettaglio personalizzazioni'] = sanitizePropertyValueCodes(
          det
            .map(function (d) {
              return d.label + ': +' + d.percentage + '% → ' + formatMoney(d.cents);
            })
            .join(' | ')
        );
        p['_Totale personalizzazioni'] = sanitizePropertyValue(
          formatMoney(det.reduce(function (a, b) { return a + b.cents; }, 0))
        );
      } else {
        p['_Personalizzazioni'] = sanitizePropertyValue('Nessuna');
        p['_Dettaglio personalizzazioni'] = sanitizePropertyValue('—');
        p['_Totale personalizzazioni'] = sanitizePropertyValue(formatMoney(0));
      }
    }
    p['_Totale config'] = sanitizePropertyValue(formatMoney(calculateGrandTotal()));
    var effectiveMin = getEffectiveMinQty();
    p['_QtyMin'] = String(effectiveMin);
    var meta = state.product && state.product.personalizationMeta;
    if (meta && isClothingPersMode() && meta.minimumOrderQuantity != null && meta.minimumOrderQuantity > 0) {
      p['_Minimo ordine personalizzazione'] = sanitizePropertyValue(String(meta.minimumOrderQuantity));
    }
    var notesVal = getPrintNotesValue();
    assignPrintNotesProperties(p, notesVal);
    var sl = document.getElementById('pc-send-later');
    if (sl && sl.checked && !isAwardsPersMode()) p['Non ho un file'] = 'Sì';
    if (state.files.length) {
      p['_Numero file'] = String(state.files.length);
      p['_Nomi file'] = sanitizePropertyValue(
        state.files
          .map(function (f) { return f && f.file && f.file.name ? f.file.name : ''; })
          .filter(Boolean)
          .join('; ')
      );
    }
    return p;
  }

  function getUploadFileEntries() {
    return (state.files || []).filter(function (entry) {
      return entry && entry.file && typeof File !== 'undefined' && entry.file instanceof File;
    });
  }

  function filePropertyLabel(index) {
    return index === 0 ? 'File grafica' : 'File grafica ' + (index + 1);
  }

  function buildCartItemFormData(item, fileEntries) {
    var fd = new FormData();
    fd.append('id', String(item.id));
    fd.append('quantity', String(item.quantity));
    var props = item.properties || {};
    Object.keys(props).forEach(function (k) {
      fd.append('properties[' + k + ']', String(props[k] != null ? props[k] : ''));
    });
    (fileEntries || []).forEach(function (entry, i) {
      fd.append('properties[' + filePropertyLabel(i) + ']', entry.file, entry.file.name);
    });
    return fd;
  }

  function parseCartAddResponse(res, rawText) {
    var contentType = (res.headers.get('content-type') || '').toLowerCase();
    var preview = String(rawText).slice(0, 300);

    if (PC_DEBUG) {
      dbg('TOTAL', {
        status: res.status,
        redirected: res.redirected,
        responseUrl: res.url,
        contentType: contentType,
        preview: preview
      });
    }

    if (!res.ok) {
      var errData = null;
      if (rawText) {
        try {
          errData = JSON.parse(rawText);
        } catch (e) {}
      }
      if (res.status === 422 && errData && errData.description) {
        throw new Error(errData.description);
      }
      throw new Error('Errore add to cart (HTTP ' + res.status + '): ' + preview);
    }

    var isJsonContentType =
      contentType.includes('application/json') ||
      contentType.includes('text/javascript') ||
      contentType.includes('application/javascript');
    var trimmed = String(rawText || '').trim();
    var looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');

    if (!isJsonContentType && !looksLikeJson) {
      if (PC_DEBUG) dbg('TOTAL', { nonJsonResponse: true, contentType: contentType, preview: preview });
      showMessage('Il server ha restituito una risposta non valida. Controlla la console.', 'error');
      throw new Error('Risposta non JSON. Content-Type: ' + contentType);
    }

    try {
      return rawText ? JSON.parse(rawText) : {};
    } catch (e) {
      if (PC_DEBUG) dbg('TOTAL', { jsonParseError: true, preview: preview });
      throw new Error('Risposta non valida: ' + (e.message || 'JSON non valido'));
    }
  }

  function toNumericVariantId(val) {
    if (val == null) return null;
    if (typeof val === 'number' && !isNaN(val) && val > 0) return val;
    var s = String(val).trim();
    if (!s) return null;
    var num = parseInt(s, 10);
    if (!isNaN(num) && num > 0) return num;
    var gidMatch = s.match(/\/ProductVariant\/(\d+)$/);
    if (gidMatch) return parseInt(gidMatch[1], 10);
    return null;
  }

  function buildCartItemsPayload() {
    var product = state.product;
    if (!product || !product.variants || !Array.isArray(product.variants)) return [];
    var shared = collectSharedLineItemProperties();
    var items = [];
    Object.keys(state.quantities).forEach(function (vid) {
      var q = state.quantities[vid] || 0;
      if (q <= 0) return;
      var v = product.variants.find(function (x) { return String(x.id) === vid; });
      if (!v) {
        if (PC_DEBUG) dbg('DATA', { missingVariant: vid });
        return;
      }
      if (!v.available) {
        if (PC_DEBUG) dbg('DATA', { unavailableVariant: v.id });
        return;
      }
      var cartV = resolveCartVariant(v) || v;
      if (!cartV.available) {
        if (PC_DEBUG) dbg('DATA', { unavailableRemappedVariant: cartV.id, matrixVariantId: v.id });
        return;
      }
      var numId = toNumericVariantId(cartV.id);
      if (!numId) {
        if (PC_DEBUG) dbg('DATA', { badVariantId: cartV.id, matrixVariantId: v.id });
        return;
      }
      var qty = parseInt(q, 10);
      if (isNaN(qty) || qty < 1) {
        if (PC_DEBUG) dbg('DATA', { badQty: q, variant: numId });
        return;
      }
      var merged = items.find(function (it) { return it.id === numId; });
      if (merged) merged.quantity += qty;
      else items.push({ id: numId, quantity: qty, properties: Object.assign({}, shared) });
    });
    var leftoverCents = getUncoveredPersonalizationSurchargeCents();
    var surchargeId = getSurchargeVariantId();
    if (leftoverCents > 0 && surchargeId) {
      var surchargeProps = Object.assign({}, shared);
      surchargeProps['Tipo'] = 'Costo personalizzazione';
      items.push({
        id: surchargeId,
        quantity: leftoverCents,
        properties: surchargeProps
      });
    } else if (leftoverCents > 0 && PC_DEBUG) {
      dbg('TOTAL', { missingSurchargeVariant: true, leftoverCents: leftoverCents });
    }
    return items;
  }

  function getCartAddUrl() {
    /* DEBUG: forza endpoint corretto per evitare redirect/HTML */
    return '/cart/add.js';
  }

  function getCartUrl() {
    var w = document.getElementById('pc-configurator');
    if (w && w.dataset.routesCart && String(w.dataset.routesCart).length > 0) return w.dataset.routesCart;
    try {
      if (typeof window.routes === 'object' && window.routes && window.routes.cart_url) return window.routes.cart_url;
    } catch (e) {}
    return '/cart';
  }

  function addConfiguredItemsToCart() {
    if (isQuantityPricingActive()) snapOrderQuantityToMinStep();
    if (!validateStep(1)) {
      if (getQuantityPricingValidationMessage()) return;
      if (getTotalQuantity() <= 0) {
        showMessage('Seleziona almeno una quantità per continuare.', 'error');
        return;
      }
      var moReason = step1ApparelMinOrderBlockReason();
      if (moReason) {
        showMessage(moReason, 'error');
        return;
      }
      showMessage('Completa le quantità minime richieste prima di aggiungere al carrello.', 'error');
      return;
    }
    if (!validateQuantityPricingRules()) return;
    if (!validateStep(2)) {
      if (isAwardsPersMode()) {
        showMessage('Inserisci almeno un’etichetta.', 'error');
      } else {
        showMessage('Completa la personalizzazione prima di aggiungere al carrello.', 'error');
      }
      return;
    }
    if (!validateStep(3)) {
      showMessage(getStep3ValidationMessage() || 'Carica un logo o inserisci le istruzioni prima di procedere.', 'error');
      return;
    }
    var items = buildCartItemsPayload();
    if (!items || !Array.isArray(items) || items.length === 0) {
      showMessage('Nessun articolo da aggiungere. Seleziona almeno una quantità.', 'error');
      return;
    }

    var validItems = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var id = it.id;
      var qty = it.quantity;
      var valid = true;
      if (id == null || (typeof id !== 'number' && typeof id !== 'string')) {
        if (PC_DEBUG) dbg('DATA', { itemInvalidId: i, id: id });
        valid = false;
      }
      var numId = typeof id === 'number' ? id : parseInt(String(id), 10);
      if (isNaN(numId) || numId <= 0) {
        if (PC_DEBUG) dbg('DATA', { itemBadNumId: i, id: id, numId: numId });
        valid = false;
      }
      var intQty = parseInt(qty, 10);
      if (isNaN(intQty) || intQty < 1) {
        if (PC_DEBUG) dbg('DATA', { itemBadQty: i, qty: qty });
        valid = false;
      }
      if (valid) {
        var props = it.properties || {};
        var safeProps = {};
        Object.keys(props).forEach(function (k) {
          safeProps[k] = String(props[k] != null ? props[k] : '');
        });
        validItems.push({ id: numId, quantity: intQty, properties: safeProps });
      } else if (PC_DEBUG) {
        dbg('DATA', { cartItemInvalid: i, id: id, qty: qty });
      }
    }

    if (validItems.length === 0) {
      showMessage('Nessun articolo valido da aggiungere. Verifica le quantità e le varianti.', 'error');
      return;
    }

    var addBtn = document.getElementById('pc-btn-add-cart');
    if (addBtn) addBtn.disabled = true;

    var url = getCartAddUrl();
    var fileEntries = getUploadFileEntries();
    var useNativeFileUpload = fileEntries.length > 0;

    if (PC_DEBUG) {
      dbg('TOTAL', {
        cartAddUrl: url,
        items: validItems.length,
        nativeFileUpload: useNativeFileUpload,
        files: fileEntries.map(function (e) {
          return { name: e.file.name, size: e.file.size, type: e.file.type };
        })
      });
    }

    var addPromise;
    if (useNativeFileUpload) {
      /* FormData + file property: Shopify salva il file sul CDN e mette l'URL in ordine.
         Un POST per variante (bulk JSON non supporta blob file). */
      addPromise = validItems.reduce(function (chain, item, idx) {
        return chain.then(function () {
          var filesForItem =
            item.properties && item.properties.Tipo === 'Costo personalizzazione' ? [] : fileEntries;
          if (PC_DEBUG) dbg('TOTAL', { nativeUploadItem: idx, id: item.id, qty: item.quantity });
          return fetch(url, {
            method: 'POST',
            headers: { Accept: 'application/json' },
            credentials: 'same-origin',
            body: buildCartItemFormData(item, filesForItem)
          }).then(function (res) {
            return res.text().then(function (rawText) {
              return parseCartAddResponse(res, rawText);
            });
          }).then(function (data) {
            if (data && data.status && data.status !== 200) {
              throw new Error(data.description || 'Errore aggiunta al carrello');
            }
            return data;
          });
        });
      }, Promise.resolve());
    } else {
      addPromise = fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        credentials: 'same-origin',
        body: JSON.stringify({ items: validItems })
      })
        .then(function (res) {
          return res.text().then(function (rawText) {
            return parseCartAddResponse(res, rawText);
          });
        })
        .then(function (data) {
          if (data && data.status && data.status !== 200) {
            throw new Error(data.description || 'Errore aggiunta al carrello');
          }
          return data;
        });
    }

    addPromise.then(function () {
      var sync = (window.pcSyncQuantityDiscounts && window.pcSyncQuantityDiscounts()) || Promise.resolve();
      return Promise.resolve(sync).then(function () {
        handleCartSuccess();
      }, function () {
        handleCartSuccess();
      });
    }).catch(function (err) {
      handleCartError(err);
    });
  }

  function handleCartSuccess() {
    var addBtn = document.getElementById('pc-btn-add-cart');
    if (addBtn) addBtn.disabled = false;
    clearMessage();
    showMessage('✓ Aggiunto al carrello!', 'success');
    var hasAjaxCart = false;
    try {
      if (typeof ajaxCart === 'object' && ajaxCart && typeof ajaxCart.load === 'function') {
        hasAjaxCart = true;
      }
    } catch (e) {}
    setTimeout(function () {
      closeModal();
      if (hasAjaxCart) {
        try { ajaxCart.load(); } catch (e) {}
      } else {
        window.location.href = getCartUrl();
      }
    }, 1500);
  }

  function handleCartError(err) {
    var addBtn = document.getElementById('pc-btn-add-cart');
    if (addBtn) addBtn.disabled = false;
    showMessage(err.message || 'Errore durante l\'aggiunta al carrello. Riprova.', 'error');
  }

  function initMobileSummaryToggle() {
    var toggle = document.getElementById('pc-mobile-summary-toggle');
    var detail = document.getElementById('pc-mobile-summary-detail');
    if (!toggle || !detail) return;
    toggle.addEventListener('click', function () {
      var isMobile = window.matchMedia('(max-width: 767px)').matches;
      if (isMobile && state.currentStep < 4) {
        goToStep(4);
        return;
      }
      var isOpen = detail.classList.toggle('pc-open');
      toggle.setAttribute('aria-expanded', isOpen);
      toggle.textContent = isOpen ? 'Nascondi riepilogo' : 'Visualizza riepilogo';
    });
  }

  function initSummaryProduct() {
    var product = state.product;
    if (!product) return;
    var imgEl = document.getElementById('pc-summary-image');
    var titleEl = document.getElementById('pc-summary-product-title');
    var blockEl = document.getElementById('pc-summary-product');
    if (!blockEl) return;
    if (titleEl) titleEl.textContent = (product.title != null ? product.title : '') + '';
    var imgUrl = (product.featured_image || product.featured_image_url || '');
    if (imgEl) {
      if (imgUrl) {
        imgEl.src = imgUrl;
        imgEl.alt = product.title ? (product.title + '') : '';
        blockEl.classList.add('pc-has-image');
      } else {
        blockEl.classList.remove('pc-has-image');
      }
    }
  }

  function initConfigurator() {
    var wrapper = document.getElementById('pc-configurator');
    if (!wrapper) return;
    var overlay = document.getElementById('pc-modal-overlay');
    if (overlay && overlay.parentNode !== document.body) {
      document.body.appendChild(overlay);
    }
    try {
      var currency = wrapper.getAttribute('data-currency');
      if (currency) CONFIG.pricingRules.currency = currency;
      state.product = getProductJson();
      if (!state.product) {
        if (PC_DEBUG) dbg('DATA', { getProductJson: null });
        showFallbackUnavailable();
        return;
      }
      state.product.personalizationOptions = sanitizePersonalizationOptionsList(state.product.personalizationOptions);
      state.product.personalizationMeta = sanitizePersonalizationMeta(state.product.personalizationMeta);
      if (
        state.product.inPremiazioniCollection === true ||
        String(state.product.productType || state.product.type || '')
          .toLowerCase()
          .indexOf('premiaz') >= 0
      ) {
        state.product.personalizationMeta.mode = 'awards';
        state.product.personalizationOptions = [];
      }
      if (state.product.isConfigurable !== true) {
        hideConfiguratorWhenNotConfigurable();
        return;
      }
      hydrateQuantityPricingFromProduct();
      renormalizeQuantityPricingBaseCentsFromVariantMinor();
      syncConfigFromProduct(state.product);
      debugLogAllVariantPricesFromLiquid();
      if (state.product.configProductType != null && String(state.product.configProductType).length > 0) {
        CONFIG.configProductType = String(state.product.configProductType);
      }
      if (PC_DEBUG) {
        dbg('DATA', { options: state.product.options });
        if (state.product.options && Array.isArray(state.product.options)) {
          state.product.options.forEach(function (opt, i) {
            var normalized = normalizeOptionValues(opt && opt.values);
            dbg('DATA', { optionIndex: i, rawValues: opt && opt.values, normalized: normalized });
          });
        }
      }
      detectVariantAxes();
      if (PC_DEBUG) {
        dbg('DATA', { colorAxis: state.colorAxis, sizeAxis: state.sizeAxis, printAxis: state.printAxis });
      }
      buildVariantMap();
      if (PC_DEBUG) {
        dbg('DATA', { variantMapKeys: Object.keys(state.variantMap) });
      }
      if (!isProductCompatible()) {
        if (PC_DEBUG) dbg('DATA', { isProductCompatible: false });
        showFallbackUnavailable();
        return;
      }
      initSummaryProduct();
      buildSizeColorMatrix();
      updateQtyPricingHint();
      initAuxiliaryUi();
      initOptionalServices();
      renderDeliveryNotesFromConfig();
      initFileUpload();
      initMobileSummaryToggle();
      updateSummary();
      lockNativeAddToCart();
      var openBtn = document.getElementById('pc-btn-open-modal');
      var closeBtn = document.getElementById('pc-btn-close-modal');
      var backdrop = document.getElementById('pc-modal-backdrop');
      if (openBtn) openBtn.addEventListener('click', openModal);
      if (closeBtn) closeBtn.addEventListener('click', closeModal);
      if (backdrop) backdrop.addEventListener('click', closeModal);
      var prevBtn = document.getElementById('pc-btn-prev');
      var nextBtn = document.getElementById('pc-btn-next');
      var addBtn = document.getElementById('pc-btn-add-cart');
      if (prevBtn) prevBtn.addEventListener('click', prevStep);
      if (nextBtn) nextBtn.addEventListener('click', nextStep);
      if (addBtn) addBtn.addEventListener('click', function () {
        if (!validateStep(3)) {
          showMessage(getStep3ValidationMessage() || 'Completa i campi obbligatori prima di procedere.', 'error');
          return;
        }
        addConfiguredItemsToCart();
      });
      var tabs = document.querySelectorAll('.pc-step-tab');
      if (tabs && tabs.length) {
        tabs.forEach(function (tab) {
          tab.addEventListener('click', function () {
            var s = parseInt(tab.dataset.step, 10);
            if (s < state.currentStep || validateStep(state.currentStep)) goToStep(s);
          });
        });
      }
      goToStep(1);
      window.addEventListener('resize', function () {
        updateMobileSummaryVisibility(state.currentStep);
      });

      /* Debug: ?pc_debug o ?pc_debug=1 - mostra sia CTA configuratore che add to cart nativo */
      if (PC_DEBUG) {
        var debugFallback = document.getElementById('pc-standard-add-to-cart-fallback');
        if (debugFallback) debugFallback.classList.remove('pc-hidden');
      }
    } catch (err) {
      showFallbackUnavailable();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initConfigurator);
  } else {
    initConfigurator();
  }
})();
