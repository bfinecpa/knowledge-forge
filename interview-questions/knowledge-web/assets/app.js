/* =========================================================
   knowledge-web — 인터랙션 레이어
   문서 페이지와 인덱스 페이지가 함께 쓴다.
   ========================================================= */
(function () {
  'use strict';

  var ROOT = document.documentElement.getAttribute('data-root') || '';
  var DOC_ID = document.documentElement.getAttribute('data-doc') || '';
  var K = {
    theme: 'kw:theme',
    test: 'kw:test',
    done: 'kw:done',
    bm: 'kw:bm',
    fold: 'kw:fold'
  };

  /* ---------- 저장소 ---------- */
  function get(k, dflt) {
    try {
      var v = localStorage.getItem(k);
      return v === null ? dflt : JSON.parse(v);
    } catch (e) { return dflt; }
  }
  function set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }

  var doneMap = get(K.done, {}) || {};
  var bmList = get(K.bm, []) || [];

  function doneOf(id) { return doneMap[id] || []; }
  function setDone(id, arr) {
    if (arr.length) doneMap[id] = arr; else delete doneMap[id];
    set(K.done, doneMap);
  }

  /* ---------- 테마 ---------- */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    var b = document.getElementById('themeBtn');
    if (b) {
      b.textContent = t === 'dark' ? '☀️' : '🌙';
      b.title = (t === 'dark' ? '라이트' : '다크') + ' 모드로 전환 (t)';
    }
  }
  var theme = get(K.theme, null);
  if (!theme) theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(theme);

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    set(K.theme, theme);
    applyTheme(theme);
  }

  /* ---------- 토스트 ---------- */
  var toastEl, toastT;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.classList.remove('on'); }, 1700);
  }

  /* =========================================================
     문서 페이지
     ========================================================= */
  function initDoc() {
    var secs = [].slice.call(document.querySelectorAll('.sec'));
    var tocLinks = [].slice.call(document.querySelectorAll('.toc a'));

    /* --- 진도 체크 --- */
    function refreshProgress() {
      var done = doneOf(DOC_ID);
      secs.forEach(function (s) {
        var on = done.indexOf(s.id) >= 0;
        s.classList.toggle('done', on);
        var c = s.querySelector('.chk');
        if (c) { c.textContent = on ? '✓' : ''; c.title = on ? '이해함 (해제하려면 클릭)' : '이해했으면 체크'; }
      });
      tocLinks.forEach(function (a) {
        var h = a.getAttribute('href') || '';
        a.classList.toggle('done', h.charAt(0) === '#' && done.indexOf(h.slice(1)) >= 0);
      });
      var n = done.length, t = secs.length;
      var lab = document.getElementById('progLabel');
      if (lab) lab.innerHTML = '<b>' + n + '/' + t + '</b> 섹션 이해';
      var ring = document.getElementById('progRing');
      if (ring) ring.style.setProperty('--p', t ? Math.round(n / t * 100) : 0);
    }

    secs.forEach(function (s) {
      var head = s.querySelector('.sec-head');
      var chk = s.querySelector('.chk');

      if (chk) chk.addEventListener('click', function (e) {
        e.stopPropagation();
        var done = doneOf(DOC_ID).slice();
        var i = done.indexOf(s.id);
        if (i >= 0) done.splice(i, 1); else done.push(s.id);
        setDone(DOC_ID, done);
        refreshProgress();
        if (i < 0 && done.length === secs.length) toast('🎉 이 문서를 전부 이해했습니다!');
      });

      if (head) head.addEventListener('click', function (e) {
        if (e.target.closest('.chk')) return;
        s.classList.toggle('collapsed');
      });
    });

    refreshProgress();

    /* --- 펼치기/접기 전체 --- */
    var foldBtn = document.getElementById('foldBtn');
    if (foldBtn) foldBtn.addEventListener('click', function () {
      var anyOpen = secs.some(function (s) { return !s.classList.contains('collapsed'); });
      secs.forEach(function (s) { s.classList.toggle('collapsed', anyOpen); });
      foldBtn.querySelector('.lbl').textContent = anyOpen ? '모두 펼치기' : '모두 접기';
    });

    /* --- 북마크 --- */
    var bmBtn = document.getElementById('bmBtn');
    function refreshBm() {
      if (!bmBtn) return;
      var on = bmList.indexOf(DOC_ID) >= 0;
      bmBtn.classList.toggle('on', on);
      bmBtn.textContent = on ? '🔖' : '🏷️';
      bmBtn.title = on ? '복습 목록에서 제거 (b)' : '복습 목록에 추가 (b)';
    }
    function toggleBm() {
      var i = bmList.indexOf(DOC_ID);
      if (i >= 0) { bmList.splice(i, 1); toast('복습 목록에서 제거'); }
      else { bmList.push(DOC_ID); toast('🔖 복습 목록에 추가'); }
      set(K.bm, bmList);
      refreshBm();
    }
    if (bmBtn) bmBtn.addEventListener('click', toggleBm);
    refreshBm();

    /* --- 셀프테스트 모드 --- */
    var maskables = [].slice.call(document.querySelectorAll('.maskable'));
    var qas = [].slice.call(document.querySelectorAll('.qa'));
    var testBtn = document.getElementById('testBtn');

    function applyTest(on) {
      maskables.forEach(function (m) { m.classList.toggle('masked', on); });
      if (on) qas.forEach(function (q) { q.classList.remove('open'); });
      if (testBtn) {
        testBtn.classList.toggle('on', on);
        testBtn.title = '셀프테스트 모드 ' + (on ? '끄기' : '켜기') + ' (s) — 요약·정답을 가리고 먼저 떠올려보세요';
      }
      maskables.forEach(function (m) {
        var b = m.querySelector('.mask-btn');
        if (b) b.textContent = m.classList.contains('masked') ? '👁 보기' : '🙈 가리기';
      });
    }
    var testOn = get(K.test, false);
    applyTest(testOn);

    function toggleTest() {
      testOn = !testOn;
      set(K.test, testOn);
      applyTest(testOn);
      toast(testOn ? '🎯 셀프테스트 모드 — 먼저 떠올려보세요' : '셀프테스트 모드 해제');
    }
    if (testBtn) testBtn.addEventListener('click', toggleTest);

    /* 개별 가리기 버튼 */
    document.addEventListener('click', function (e) {
      var b = e.target.closest('.mask-btn');
      if (!b) return;
      var box = b.closest('.maskable');
      if (!box) return;
      box.classList.toggle('masked');
      b.textContent = box.classList.contains('masked') ? '👁 보기' : '🙈 가리기';
    });

    /* --- 꼬리질문 Q&A --- */
    qas.forEach(function (q) {
      var btn = q.querySelector('.qa-q');
      if (btn) btn.addEventListener('click', function () { q.classList.toggle('open'); });
    });

    /* --- 코드 복사 --- */
    document.addEventListener('click', function (e) {
      var b = e.target.closest('.copy');
      if (!b) return;
      var pre = b.closest('.code').querySelector('pre');
      var txt = pre ? pre.innerText : '';
      var done = function () {
        b.textContent = '복사됨';
        b.classList.add('ok');
        setTimeout(function () { b.textContent = '복사'; b.classList.remove('ok'); }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done, function () {});
      } else {
        var ta = document.createElement('textarea');
        ta.value = txt; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (err) {}
        document.body.removeChild(ta);
      }
    });

    /* --- 목차 스크롤 스파이 + 진행 막대 --- */
    var bar = document.querySelector('.progress > i');
    var anchored = tocLinks.filter(function (a) { return (a.getAttribute('href') || '').charAt(0) === '#'; });
    var ticking = false;

    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var h = document.documentElement.scrollHeight - innerHeight;
        if (bar) bar.style.width = (h > 0 ? Math.min(100, Math.max(0, scrollY / h * 100)) : 0) + '%';

        var line = scrollY + 130, cur = null;
        anchored.forEach(function (a) {
          var el = document.getElementById(a.getAttribute('href').slice(1));
          if (el && el.getBoundingClientRect().top + scrollY <= line) cur = a;
        });
        if (!cur && anchored.length) cur = anchored[0];
        anchored.forEach(function (a) { a.classList.toggle('active', a === cur); });
      });
    }
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    /* --- 모바일 사이드바 --- */
    var side = document.querySelector('.sidebar');
    var menu = document.getElementById('menuBtn');
    var scrim = document.querySelector('.scrim');
    function closeSide() {
      if (side) side.classList.remove('open');
      if (scrim) scrim.classList.remove('on');
    }
    if (menu) menu.addEventListener('click', function () {
      side.classList.toggle('open');
      if (scrim) scrim.classList.toggle('on', side.classList.contains('open'));
    });
    if (scrim) scrim.addEventListener('click', closeSide);
    tocLinks.forEach(function (a) { a.addEventListener('click', closeSide); });

    /* --- 섹션 이동 --- */
    function jump(dir) {
      var tops = secs.map(function (s) { return s.getBoundingClientRect().top; });
      var idx = -1;
      if (dir > 0) {
        for (var i = 0; i < tops.length; i++) if (tops[i] > 8) { idx = i; break; }
      } else {
        for (var j = tops.length - 1; j >= 0; j--) if (tops[j] < -8) { idx = j; break; }
      }
      if (idx >= 0) secs[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    document.__kw = { toggleTest: toggleTest, toggleBm: toggleBm, jump: jump, closeSide: closeSide };
  }

  /* =========================================================
     전역 검색 (모든 페이지)
     ========================================================= */
  function initFinder() {
    var docs = window.KW_DOCS || [];
    if (!docs.length) return;

    var wrap = document.createElement('div');
    wrap.className = 'finder';
    wrap.innerHTML =
      '<div class="finder-box">' +
      '<input type="text" placeholder="문서 검색 — 제목 · 핵심 요약 · 섹션" autocomplete="off" spellcheck="false">' +
      '<div class="finder-res"></div>' +
      '<div class="finder-foot"><kbd>↑</kbd><kbd>↓</kbd> 이동 · <kbd>Enter</kbd> 열기 · <kbd>Esc</kbd> 닫기</div>' +
      '</div>';
    document.body.appendChild(wrap);

    var input = wrap.querySelector('input');
    var res = wrap.querySelector('.finder-res');
    var hits = [], sel = 0;

    function esc(s) {
      return String(s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
      });
    }
    function mark(text, q) {
      var t = esc(text);
      if (!q) return t;
      var i = t.toLowerCase().indexOf(q.toLowerCase());
      if (i < 0) return t;
      return t.slice(0, i) + '<mark>' + t.slice(i, i + q.length) + '</mark>' + t.slice(i + q.length);
    }

    function render(q) {
      var ql = q.trim().toLowerCase();
      hits = !ql ? docs.slice(0, 12) : docs.filter(function (d) {
        return (d.title + ' ' + d.summary + ' ' + d.catTitle + ' ' + (d.secs || []).join(' '))
          .toLowerCase().indexOf(ql) >= 0;
      }).slice(0, 30);
      sel = 0;
      if (!hits.length) { res.innerHTML = '<div class="fr-none">검색 결과가 없습니다.</div>'; return; }
      res.innerHTML = hits.map(function (d, i) {
        return '<a href="' + ROOT + esc(d.path) + '" class="' + (i === 0 ? 'sel' : '') + '">' +
          '<span class="fr-cat">' + esc(d.catTitle) + '</span>' + mark(d.title, q.trim()) + '</a>';
      }).join('');
    }

    function open() {
      wrap.classList.add('on');
      input.value = '';
      render('');
      setTimeout(function () { input.focus(); }, 20);
    }
    function close() { wrap.classList.remove('on'); }

    input.addEventListener('input', function () { render(input.value); });
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });

    input.addEventListener('keydown', function (e) {
      var items = res.querySelectorAll('a');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        [].forEach.call(items, function (a, i) { a.classList.toggle('sel', i === sel); });
        items[sel].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (items[sel]) location.href = items[sel].getAttribute('href');
      } else if (e.key === 'Escape') { close(); }
    });

    var btn = document.getElementById('searchBtn');
    if (btn) btn.addEventListener('click', open);

    document.__kwFinder = { open: open, close: close, isOpen: function () { return wrap.classList.contains('on'); } };
  }

  /* =========================================================
     인덱스 페이지
     ========================================================= */
  function initHome() {
    var docs = window.KW_DOCS || [];
    var input = document.getElementById('homeSearch');
    var chips = [].slice.call(document.querySelectorAll('.chip'));
    var cats = [].slice.call(document.querySelectorAll('.cat'));
    var cards = [].slice.call(document.querySelectorAll('.card'));
    var mode = 'all';

    function stats() {
      var total = docs.length, doneDocs = 0, doneSecs = 0, totalSecs = 0;
      docs.forEach(function (d) {
        var n = doneOf(d.id).length;
        doneSecs += n; totalSecs += d.secCount;
        if (d.secCount && n >= d.secCount) doneDocs++;
      });
      var setv = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
      setv('stDocs', total);
      setv('stDone', doneDocs);
      setv('stBm', bmList.length);
      setv('stPct', (totalSecs ? Math.round(doneSecs / totalSecs * 100) : 0) + '%');
      var b = document.getElementById('stBar');
      if (b) b.style.width = (totalSecs ? doneSecs / totalSecs * 100 : 0) + '%';

      cards.forEach(function (c) {
        var id = c.getAttribute('data-id');
        var d = docs.find(function (x) { return x.id === id; });
        if (!d) return;
        var n = doneOf(id).length;
        c.classList.toggle('done', d.secCount > 0 && n >= d.secCount);
        var bm = c.querySelector('.bm');
        if (bm) bm.textContent = bmList.indexOf(id) >= 0 ? '🔖' : '';
        var pg = c.querySelector('.pg');
        if (pg) pg.textContent = n + '/' + d.secCount + ' 섹션';
      });
    }

    function filter() {
      var q = (input ? input.value : '').trim().toLowerCase();
      var shown = 0;
      cards.forEach(function (c) {
        var id = c.getAttribute('data-id');
        var d = docs.find(function (x) { return x.id === id; }) || {};
        var hay = (c.textContent + ' ' + (d.summary || '') + ' ' + (d.secs || []).join(' ')).toLowerCase();
        var okQ = !q || hay.indexOf(q) >= 0;
        var n = doneOf(id).length;
        var okM = mode === 'all'
          || (mode === 'todo' && !(d.secCount > 0 && n >= d.secCount))
          || (mode === 'done' && d.secCount > 0 && n >= d.secCount)
          || (mode === 'bm' && bmList.indexOf(id) >= 0);
        var on = okQ && okM;
        c.style.display = on ? '' : 'none';
        if (on) shown++;
      });
      cats.forEach(function (cat) {
        var vis = [].slice.call(cat.querySelectorAll('.card')).some(function (c) { return c.style.display !== 'none'; });
        cat.style.display = vis ? '' : 'none';
      });
      var em = document.getElementById('emptyMsg');
      if (em) em.style.display = shown ? 'none' : '';
    }

    if (input) input.addEventListener('input', filter);
    chips.forEach(function (ch) {
      ch.addEventListener('click', function () {
        chips.forEach(function (x) { x.classList.toggle('on', x === ch); });
        mode = ch.getAttribute('data-mode');
        filter();
      });
    });

    var reset = document.getElementById('resetBtn');
    if (reset) reset.addEventListener('click', function () {
      if (!confirm('모든 진도 체크와 복습 목록을 초기화할까요?')) return;
      doneMap = {}; bmList = [];
      set(K.done, doneMap); set(K.bm, bmList);
      stats(); filter();
      toast('진도를 초기화했습니다');
    });

    stats();
    filter();
  }

  /* =========================================================
     키보드 단축키
     ========================================================= */
  addEventListener('keydown', function (e) {
    var t = e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    var F = document.__kwFinder;

    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault(); if (F) F.open(); return;
    }
    if (e.key === 'Escape') {
      if (F && F.isOpen()) F.close();
      else if (document.__kw) document.__kw.closeSide();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

    var D = document.__kw;
    switch (e.key) {
      case '/': e.preventDefault(); if (F) F.open(); break;
      case 't': toggleTheme(); break;
      case 's': if (D) { e.preventDefault(); D.toggleTest(); } break;
      case 'b': if (D) D.toggleBm(); break;
      case 'j': if (D) { e.preventDefault(); D.jump(1); } break;
      case 'k': if (D) { e.preventDefault(); D.jump(-1); } break;
      case 'h': location.href = ROOT + 'index.html'; break;
    }
  });

  /* ---------- 부팅 ---------- */
  var themeBtn = document.getElementById('themeBtn');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  if (document.body.classList.contains('page-doc')) initDoc();
  if (document.body.classList.contains('page-home')) initHome();
  initFinder();
})();
