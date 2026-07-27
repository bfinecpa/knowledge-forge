#!/usr/bin/env node
/* =========================================================
   knowledge-web 빌더
   ../knowledge/**.md  →  ./**.html  (폴더 구조 1:1 미러링)

   사용법:  node build.mjs
   ========================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'knowledge');
const OUT = HERE;

/* 상단바 "경로 복사" 버튼이 클립보드에 넣는 값은 저장소 루트 기준 경로다.
   (예: interview-questions/knowledge/02-spring/xxx.md → 에디터·CLI 에 바로 붙여 쓸 수 있다) */
const REPO = path.resolve(HERE, '..', '..');
const posixRel = (p) => path.relative(REPO, p).split(path.sep).join('/');
const SRC_REL = posixRel(SRC);
const OUT_REL = posixRel(OUT);

/* 카테고리별 색상(hue) — 카테고리마다 색이 달라 시각적으로 기억에 남는다 */
const HUES = {
  '01-java-kotlin': 25, '02-spring': 132, '03-jpa-orm': 200, '04-rdb-sql': 218,
  '05-redis-caching': 355, '06-kafka-messaging': 265, '07-traffic-performance': 330,
  '08-network-http': 192, '09-rest-api': 165, '10-payment-consistency': 42,
  '11-spring-batch': 100, '12-nosql': 288, '13-architecture': 235,
  '14-operations-observability': 12, '15-container-infra': 205, '16-security': 0,
  '17-test-quality': 150, '18-async-nonblocking': 250, '19-cs-fundamentals': 32,
  '20-experience-scenario': 315, '21-system-design': 182, '22-global-i18n': 172,
  '23-build-cicd': 78, '24-ai-tools': 278, '25-senior-differentiation': 348,
  '26-auth-session': 242
};

/* =========================================================
   0. 유틸
   ========================================================= */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* 목차·브레드크럼처럼 태그를 못 쓰는 자리에 넣을 평문 */
const txt = (s) => String(s)
  .replace(/`([^`]*)`/g, '$1')
  .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
  .replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1')
  .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
  .trim();

/* 마크다운 기호를 걷어낸 평문 (요약·검색용) */
function plain(md) {
  return String(md)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([\s\S]*?)\*\*/g, '$1')
    .replace(/\*([^*\n]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[>#\s-]+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* =========================================================
   1. 문법 하이라이트
   ========================================================= */
const JAVA_KW = 'abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|float|for|goto|if|implements|import|instanceof|int|interface|long|native|new|package|private|protected|public|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while|var|record|sealed|permits|yield|true|false|null|fun|val|when|is|in|as|object|companion|data|suspend|open|override|lateinit|init|by|out|reified|inline|internal|typealias';

const RULES = {
  java: {
    flags: 'gm',
    rules: [
      ['com', '//[^\\n]*|/\\*[\\s\\S]*?\\*/'],
      ['str', '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\''],
      ['anno', '@\\w+'],
      ['kw', `\\b(?:${JAVA_KW})\\b`],
      ['num', '\\b\\d[\\d_]*(?:\\.\\d+)?(?:[LlFfDd])?\\b'],
      ['type', '\\b[A-Z][A-Za-z0-9_]*\\b'],
      ['fn', '\\b[a-z_]\\w*(?=\\s*\\()']
    ]
  },
  yaml: {
    flags: 'gm',
    rules: [
      ['com', '#[^\\n]*'],
      ['str', '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:[^\'\\n])*\''],
      ['key', '^[ \\t]*-?[ \\t]*[\\w.$\\[\\]{}-]+(?=[ \\t]*:)'],
      ['kw', '\\b(?:true|false|null|yes|no|on|off)\\b'],
      ['num', '\\b\\d[\\d_]*(?:\\.\\d+)?\\b']
    ]
  },
  bash: {
    flags: 'gm',
    rules: [
      ['com', '#[^\\n]*'],
      ['str', '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:[^\'\\n])*\''],
      ['key', '\\$\\w+|\\$\\{[^}\\n]*\\}'],
      ['kw', '\\b(?:if|then|else|fi|for|do|done|while|case|esac|function|export|local|return|echo|sudo|cd)\\b'],
      ['num', '\\b\\d+\\b']
    ]
  },
  sql: {
    flags: 'gmi',
    rules: [
      ['com', '--[^\\n]*|/\\*[\\s\\S]*?\\*/'],
      ['str', "'(?:''|[^'\\n])*'"],
      ['kw', '\\b(?:select|from|where|insert|into|values|update|set|delete|join|left|right|inner|outer|on|group|order|by|having|limit|offset|union|all|as|and|or|not|null|is|in|exists|between|like|case|when|then|end|create|table|index|alter|drop|primary|key|foreign|references|begin|commit|rollback|transaction|isolation|level|lock|share|mode|for|distinct|count|sum|avg|max|min|desc|asc|with)\\b'],
      ['num', '\\b\\d+\\b']
    ]
  }
};
RULES.kotlin = RULES.java;
RULES.js = RULES.java;
RULES.json = RULES.yaml;
RULES.properties = RULES.yaml;
RULES.shell = RULES.bash;
RULES.sh = RULES.bash;

function highlight(code, lang) {
  const spec = RULES[String(lang).toLowerCase()];
  if (!spec) return esc(code);
  const re = new RegExp(spec.rules.map((r) => `(${r[1]})`).join('|'), spec.flags);
  let out = '', last = 0, m;
  while ((m = re.exec(code)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out += esc(code.slice(last, m.index));
    let cls = 'op';
    for (let g = 1; g < m.length; g++) {
      if (m[g] !== undefined) { cls = spec.rules[g - 1][0]; break; }
    }
    out += `<span class="tk-${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}

/* =========================================================
   2. 마크다운 블록 파서
   ========================================================= */
const RE_LI = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RE_H = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_FENCE = /^\s*```(\S*)([^\n]*)$/;
const RE_HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const RE_TSEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

function isBlockStart(l) {
  return !l.trim() || RE_H.test(l) || RE_FENCE.test(l) || RE_HR.test(l) ||
    RE_LI.test(l) || /^\s*>/.test(l);
}

function splitRow(line) {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '', tick = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '`') tick = !tick;
    if (c === '|' && !tick && s[i - 1] !== '\\') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells.map((c) => c.trim().replace(/\\\|/g, '|'));
}

function parseBlocks(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    /* 코드 펜스 */
    let m = RE_FENCE.exec(line);
    if (m) {
      const lang = (m[1] || 'text').toLowerCase();
      const meta = (m[2] || '').trim().toLowerCase();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push({ t: 'code', lang, meta, code: buf.join('\n').replace(/\s+$/, '') });
      continue;
    }

    /* 헤딩 */
    m = RE_H.exec(line);
    if (m) { out.push({ t: 'h', level: m[1].length, text: m[2].trim() }); i++; continue; }

    /* 수평선 */
    if (RE_HR.test(line)) { out.push({ t: 'hr' }); i++; continue; }

    /* 인용 */
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push({ t: 'quote', blocks: parseBlocks(buf.join('\n')) });
      continue;
    }

    /* 표 */
    if (line.includes('|') && i + 1 < lines.length &&
        lines[i + 1].includes('|') && RE_TSEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) =>
        /^:.*:$/.test(c) ? 'center' : /:$/.test(c) ? 'right' : /^:/.test(c) ? 'left' : '');
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i])); i++;
      }
      out.push({ t: 'table', head, align, rows });
      continue;
    }

    /* 리스트 */
    m = RE_LI.exec(line);
    if (m) {
      const base = m[1].length;
      const buf = [];
      while (i < lines.length) {
        const L = lines[i];
        if (!L.trim()) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          const nxt = lines[j];
          if (j < lines.length && (RE_LI.test(nxt) || nxt.match(/^\s*/)[0].length > base)) {
            buf.push(''); i++; continue;
          }
          break;
        }
        const ind = L.match(/^\s*/)[0].length;
        if (RE_LI.test(L) || ind > base) { buf.push(L); i++; continue; }
        if (buf.length && buf[buf.length - 1].trim() && !isBlockStart(L)) { buf.push(L); i++; continue; }
        break;
      }
      out.push(parseList(buf, base));
      continue;
    }

    /* 문단 */
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) &&
           !(lines[i].includes('|') && i + 1 < lines.length && RE_TSEP.test(lines[i + 1]))) {
      para.push(lines[i]); i++;
    }
    out.push({ t: 'p', text: para.join('\n') });
  }
  return out;
}

function parseList(lines, base) {
  const items = [];
  let ordered = null, cur = null;
  const strip = new RegExp(`^\\s{0,${base + 2}}`);

  for (const L of lines) {
    const m = RE_LI.exec(L);
    if (m && m[1].length <= base + 1) {
      if (ordered === null) ordered = /\d/.test(m[2]);
      cur = [m[3]];
      items.push(cur);
    } else if (cur) {
      cur.push(L.replace(strip, ''));
    }
  }
  return {
    t: 'list',
    ordered: !!ordered,
    items: items.map((it) => parseBlocks(it.join('\n')))
  };
}

/* =========================================================
   3. 인라인 렌더링
   ========================================================= */
let LINK_MAP = new Map();   // 'foo.md' → '01-x/foo.html' (사이트 루트 기준)
let CUR_ROOT = '';          // 현재 렌더 중인 문서에서 루트까지의 상대 경로

function inline(src) {
  let t = esc(String(src));

  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => `\u0000C${codes.push(c) - 1}\u0000`);

  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, href) => {
    let h = href;
    if (/\.md(#.*)?$/i.test(h) && !/^https?:/i.test(h)) h = h.replace(/\.md/i, '.html');
    const ext = /^https?:/i.test(h) ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${h}"${ext}>${txt}</a>`;
  });

  t = t.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '<em>$1</em>');
  t = t.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');

  t = t.replace(/\u0000C(\d+)\u0000/g, (_, n) => {
    const raw = codes[+n];
    const target = LINK_MAP.get(raw.trim());
    const code = `<code>${raw}</code>`;
    return target ? `<a href="${CUR_ROOT}${target}" class="xref">${code}</a>` : code;
  });

  return t.replace(/\n/g, ' ');
}

/* =========================================================
   4. Before / After 코드 분리
   ========================================================= */
function splitBA(code) {
  const lines = code.split('\n');
  const marks = [];
  lines.forEach((l, idx) => {
    const m = /^\s*(?:\/\/|#|--)\s*(Before|After)\b\s*[:—-]?\s*(.*)$/i.exec(l);
    if (m) marks.push({ i: idx, kind: m[1].toLowerCase(), note: m[2].trim() });
  });
  if (!marks.length) return null;

  if (marks.length === 1) {
    const body = lines.filter((_, idx) => idx !== marks[0].i).join('\n').trim();
    if (!body) return null;
    return { single: marks[0].kind, code: body, note: marks[0].note };
  }
  if (marks.length !== 2 || marks[0].kind !== 'before' || marks[1].kind !== 'after') return null;
  if (marks[0].i > 1) return null;

  const before = lines.slice(marks[0].i + 1, marks[1].i).join('\n').trim();
  const after = lines.slice(marks[1].i + 1).join('\n').trim();
  if (!before || !after) return null;
  return { before, after, beforeNote: marks[0].note, afterNote: marks[1].note };
}

function codeBlockHTML(code, lang) {
  return `<div class="code">
<div class="code-bar"><span class="code-lang">${esc(lang)}</span><span class="sp"></span><button class="copy" type="button">복사</button></div>
<pre><code>${highlight(code, lang)}</code></pre>
</div>`;
}

function baPanel(kind, code, lang, note) {
  const isBad = kind === 'before';
  const tag = isBad ? '✕ BEFORE' : '✓ AFTER';
  return `<div class="code ba-${kind}">
<div class="code-bar"><span class="ba-tag">${tag}</span>${note ? `<span class="ba-note">${esc(note)}</span>` : ''}<span class="sp"></span><button class="copy" type="button">복사</button></div>
<pre><code>${highlight(code, lang)}</code></pre>
</div>`;
}

function renderCode(node) {
  if (node.lang === 'flow') return flowHTML(node.code, node.meta || '');
  const ba = splitBA(node.code);
  if (!ba) return codeBlockHTML(node.code, node.lang);
  if (ba.single) {
    return `<div class="ba">${baPanel(ba.single, ba.code, node.lang, ba.note)}</div>`;
  }
  return `<div class="ba two">
${baPanel('before', ba.before, node.lang, ba.beforeNote)}
${baPanel('after', ba.after, node.lang, ba.afterNote)}
</div>`;
}

/* =========================================================
   4-b. flow 다이어그램 — 빌드 타임 인라인 SVG
   ---------------------------------------------------------
   ```flow 펜스를 파이프라인 그림으로 바꾼다.
   외부 라이브러리·런타임 JS 0. 색은 전부 CSS 변수를 참조하므로
   라이트/다크 테마와 카테고리별 --hue 를 자동으로 따라간다.
   SVG <text> 라 글자는 선택·검색·확대가 되고, 소스가 텍스트라
   git diff 에 변경이 그대로 남는다.

   문법:
     # 캡션                     그림 아래 설명
     == 존 이름                 점선으로 묶이는 영역 (생략 가능)
     ① 단계 제목 | 보조 설명     단계 (①~⑳ 로 시작하면 뱃지로 분리)
       - 하위 단계 | 보조 설명   직전 단계의 내부 절차
       ! 증상 → 원인            이 단계에서 죽었을 때의 신호 (빨강)
     ? ⑤ 조건부 단계            ? 로 시작하면 점선 테두리
   ========================================================= */
const F = {
  W: 720, NX: 27, ZX: 13, PAD: 13,
  GAP: 27, ZTOP: 27, ZBOT: 15,
  S_TITLE: 15, S_NOTE: 12.5, S_SUB: 12.5, S_FAIL: 12.5,
  H_TITLE: 22, H_NOTE: 17, H_SUB: 21, H_FAIL: 17
};
F.NW = F.W - 2 * F.NX;          /* 카드 너비 */
F.TX = F.NX + F.PAD;            /* 카드 안쪽 텍스트 시작 x */

/* 글자 폭 추정 — 한글·CJK 는 1em, 라틴은 약 0.52em */
const charW = (ch) => {
  const c = ch.codePointAt(0);
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
         (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
         (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ? 1 : 0.52;
};
const textW = (s, size) => [...s].reduce((a, ch) => a + charW(ch), 0) * size;

/* 폭에 맞춰 줄바꿈 — 공백·구분자에서 끊고, 없으면 글자 단위로 */
function wrapText(s, size, maxW) {
  const out = [];
  let line = '', w = 0;
  for (const ch of [...s]) {
    const cw = charW(ch) * size;
    if (w + cw > maxW && line) {
      const m = /^(.*[\s·,—/→])([^\s·,—/→]*)$/.exec(line);
      if (m && m[2] && textW(m[2], size) < maxW * 0.45) {
        out.push(m[1].replace(/\s+$/, ''));
        line = m[2]; w = textW(m[2], size);
      } else { out.push(line); line = ''; w = 0; }
    }
    line += ch; w += cw;
  }
  if (line.trim()) out.push(line);
  return out.length ? out : [''];
}

/* 원문자(①)는 뱃지 안에서 너무 작아 읽히지 않는다 — 원은 뱃지 모양이 대신하고
   숫자만 남긴다. 본문 산문은 ①②③ 를 그대로 써도 1:1로 대응된다. */
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const deCircle = (s) => s.replace(/[①-⑳]/g, (c) => String(CIRCLED.indexOf(c) + 1));

const cut2 = (s) => {
  const i = s.indexOf('|');
  return i < 0 ? [s.trim(), ''] : [s.slice(0, i).trim(), s.slice(i + 1).trim()];
};

function parseFlow(src) {
  const spec = { caption: '', zones: [] };
  let zone = null, node = null;
  const zoneOf = () => (zone || (spec.zones.push(zone = { label: '', nodes: [] }), zone));

  for (const raw of String(src).split('\n')) {
    if (!raw.trim()) continue;
    let m;
    if ((m = /^\s*#\s+(.*)$/.exec(raw))) { spec.caption = m[1].trim(); continue; }
    if ((m = /^\s*==\s*(.*)$/.exec(raw))) {
      spec.zones.push(zone = { label: m[1].trim(), nodes: [] }); node = null; continue;
    }
    if (node && (m = /^\s+-\s+(.*)$/.exec(raw))) {
      const [text, note] = cut2(m[1]);
      node.subs.push({ text, note }); continue;
    }
    if (node && (m = /^\s+!\s+(.*)$/.exec(raw))) { node.fail = m[1].trim(); continue; }

    let s = raw.trim(), cond = false;
    if (s.startsWith('?')) { cond = true; s = s.slice(1).trim(); }
    let badge = '';
    if ((m = /^([①-⑳](?:-[a-z])?)\s*(.*)$/.exec(s))) { badge = deCircle(m[1]); s = m[2]; }
    const [title, note] = cut2(s);
    node = { badge, title, note, cond, subs: [], fail: '' };
    zoneOf().nodes.push(node);
  }
  return spec;
}

/* 각 카드의 높이를 확정하고 y 좌표를 배치 */
function layoutFlow(spec, compact) {
  const innerW = F.NW - 2 * F.PAD;

  for (const z of spec.zones) {
    for (const n of z.nodes) {
      n.bw = n.badge ? Math.max(22, Math.round(textW(n.badge, 12.5)) + 11) : 0;
      n.tLines = wrapText(n.title, F.S_TITLE, innerW - (n.bw ? n.bw + 8 : 0));
      n.nLines = n.note ? wrapText(n.note, F.S_NOTE, innerW) : [];
      n.fLines = n.fail ? wrapText(n.fail, F.S_FAIL, innerW - 34) : [];
      n.subs.forEach((s) => {
        s.line = s.note ? `${s.text} — ${s.note}` : s.text;
        s.lines = wrapText(s.line, F.S_SUB, innerW - 22);
      });
      if (compact) { n.subs = []; }

      n.h = F.PAD
        + n.tLines.length * F.H_TITLE
        + n.nLines.length * F.H_NOTE
        + (n.subs.length ? 7 + n.subs.reduce((a, s) => a + s.lines.length * F.H_SUB, 0) : 0)
        + (n.fLines.length ? 9 + n.fLines.length * F.H_FAIL + 12 : 0)
        + F.PAD;
    }
  }

  let y = 0;
  spec.zones.forEach((z, zi) => {
    const boxed = !!z.label;
    z.top = y;
    if (boxed) y += F.ZTOP;
    z.nodes.forEach((n, ni) => {
      n.y = y; y += n.h;
      if (ni < z.nodes.length - 1) y += F.GAP;
    });
    if (boxed) y += F.ZBOT;
    z.h = y - z.top;
    if (zi < spec.zones.length - 1) y += F.GAP;
  });
  spec.h = y;
  return spec;
}

const arrow = (y1, y2) => {
  const x = F.W / 2;
  return `<path class="fl-arw" d="M${x} ${y1 + 4}V${y2 - 9}"/>` +
         `<path class="fl-arh" d="M${x} ${y2 - 2}l-4.5 -8h9z"/>`;
};

function flowSVG(spec) {
  const p = [];

  /* 존 배경 */
  for (const z of spec.zones) {
    if (!z.label) continue;
    p.push(`<rect class="fl-zone" x="${F.ZX}" y="${z.top}" width="${F.W - 2 * F.ZX}" height="${z.h}" rx="14"/>`);
    const w = textW(z.label, 11) + 20;
    p.push(`<rect class="fl-zlbl-bg" x="${F.ZX + 15}" y="${z.top - 9}" width="${w}" height="19" rx="9.5"/>`);
    p.push(`<text class="fl-zlbl" x="${F.ZX + 15 + w / 2}" y="${z.top + 4}" text-anchor="middle">${esc(z.label)}</text>`);
  }

  /* 카드 + 화살표 */
  const flat = spec.zones.flatMap((z) => z.nodes);
  flat.forEach((n, i) => {
    if (i < flat.length - 1) p.push(arrow(n.y + n.h, flat[i + 1].y));

    p.push(`<rect class="fl-card${n.cond ? ' cond' : ''}" x="${F.NX}" y="${n.y}" width="${F.NW}" height="${n.h}" rx="11"/>`);
    let ty = n.y + F.PAD + 16;

    if (n.badge) {
      p.push(`<rect class="fl-badge-bg" x="${F.TX}" y="${ty - 15}" width="${n.bw}" height="22" rx="11"/>`);
      p.push(`<text class="fl-badge" x="${F.TX + n.bw / 2}" y="${ty + 1}" text-anchor="middle">${esc(n.badge)}</text>`);
    }
    const tx = n.badge ? F.TX + n.bw + 8 : F.TX;
    n.tLines.forEach((l, k) => {
      p.push(`<text class="fl-title" x="${tx}" y="${ty + k * F.H_TITLE}">${esc(l)}</text>`);
    });
    ty += n.tLines.length * F.H_TITLE;

    n.nLines.forEach((l, k) => {
      p.push(`<text class="fl-note" x="${F.TX}" y="${ty + k * F.H_NOTE - 3}">${esc(l)}</text>`);
    });
    ty += n.nLines.length * F.H_NOTE;

    if (n.subs.length) {
      const railX = F.TX + 4;
      const marks = [];
      let sy = ty + 8;
      n.subs.forEach((s) => {
        marks.push(`<circle class="fl-dot" cx="${railX}" cy="${sy - 4}" r="2.8"/>`);
        s.lines.forEach((l, k) => {
          marks.push(`<text class="fl-sub" x="${railX + 12}" y="${sy + k * F.H_SUB}">${esc(l)}</text>`);
        });
        sy += s.lines.length * F.H_SUB;
      });
      /* 레일을 먼저 깔고 점을 위에 얹는다 — 선이 점을 가로지르지 않도록 */
      p.push(`<path class="fl-rail" d="M${railX} ${ty}V${sy - F.H_SUB + 2}"/>`, ...marks);
      ty = sy;
    }

    if (n.fLines.length) {
      const bh = n.fLines.length * F.H_FAIL + 12;
      p.push(`<rect class="fl-fail-bg" x="${F.TX - 4}" y="${ty}" width="${F.NW - 2 * F.PAD + 8}" height="${bh}" rx="7"/>`);
      p.push(`<text class="fl-fail-ic" x="${F.TX + 6}" y="${ty + 16}">⚠</text>`);
      n.fLines.forEach((l, k) => {
        p.push(`<text class="fl-fail" x="${F.TX + 24}" y="${ty + 16 + k * F.H_FAIL}">${esc(l)}</text>`);
      });
    }
  });

  return p.join('\n');
}

function flowHTML(src, meta) {
  const compact = /\bcompact\b/.test(meta);
  const spec = layoutFlow(parseFlow(src), compact);
  const alt = spec.zones.flatMap((z) => z.nodes)
    .map((n) => [n.badge, n.title].filter(Boolean).join(' ')).join(' → ');

  return `<figure class="figure">
<svg class="flow" viewBox="0 -10 ${F.W} ${spec.h + 20}" width="100%" role="img" aria-label="${esc(alt)}" preserveAspectRatio="xMidYMin meet">
<title>${esc(spec.caption || alt)}</title>
${flowSVG(spec)}
</svg>
${spec.caption ? `<figcaption>${inline(spec.caption)}</figcaption>` : ''}
</figure>`;
}

/* =========================================================
   5. 블록 렌더링
   ========================================================= */
function renderBlocks(nodes, opt = {}) {
  const out = [];
  for (const n of nodes) {
    switch (n.t) {
      case 'h': {
        const lv = Math.min(6, Math.max(3, n.level));
        /* 목차 링크 대상은 h3뿐이라 h4 이하는 id가 없다 — 빈 id="" 를 남기지 않는다 */
        const anchor = opt.ids ? opt.ids(n) : '';
        const id = anchor ? ` id="${anchor}"` : '';
        out.push(`<h${lv}${id}>${inline(n.text)}</h${lv}>`);
        break;
      }
      case 'code':
        out.push(renderCode(n));
        break;
      case 'hr':
        out.push('<hr class="rule">');
        break;
      case 'quote':
        out.push(`<div class="callout"><span class="ic">💡</span><div>${renderBlocks(n.blocks, opt)}</div></div>`);
        break;
      case 'table': {
        const head = n.head.map((c, i) =>
          `<th${n.align[i] ? ` style="text-align:${n.align[i]}"` : ''}>${inline(c)}</th>`).join('');
        const body = n.rows.map((r) =>
          `<tr>${n.head.map((_, i) =>
            `<td${n.align[i] ? ` style="text-align:${n.align[i]}"` : ''}>${inline(r[i] ?? '')}</td>`).join('')}</tr>`).join('\n');
        out.push(`<div class="tw"><table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table></div>`);
        break;
      }
      case 'list': {
        const tag = n.ordered ? 'ol' : 'ul';
        const items = n.items.map((blocks) => {
          if (blocks.length === 1 && blocks[0].t === 'p') return `<li>${inline(blocks[0].text)}</li>`;
          return `<li>${renderBlocks(blocks, opt)}</li>`;
        }).join('\n');
        out.push(`<${tag}>\n${items}\n</${tag}>`);
        break;
      }
      case 'p': {
        const txt = n.text.trim();
        let m = /^\*\*질문\*\*\s*[:：]\s*([\s\S]+)$/.exec(txt);
        if (m) {
          out.push(`<div class="ask"><span class="ask-l">면접 질문</span><p class="ask-q">${inline(m[1].trim())}</p></div>`);
          break;
        }
        m = /^\*\*(출제 의도|의도)\*\*\s*[:：]\s*([\s\S]+)$/.exec(txt);
        if (m) {
          out.push(`<div class="intent"><span class="ask-l">출제 의도</span>${inline(m[2].trim())}</div>`);
          break;
        }
        out.push(`<p>${inline(txt)}</p>`);
        break;
      }
    }
  }
  return out.join('\n');
}

/* =========================================================
   6. 꼬리질문 → Q&A 카드
   ========================================================= */
const stripQuotes = (s) => s.replace(/^\s*["“”'']+|["“”'']+\s*$/g, '').trim();

function renderQA(nodes) {
  const out = [];
  let i = 0;
  let count = 0;
  const cards = [];

  while (i < nodes.length) {
    const n = nodes[i];

    /* ### "질문?" 형태 */
    if (n.t === 'h' && n.level >= 3) {
      const body = [];
      i++;
      while (i < nodes.length && !(nodes[i].t === 'h' && nodes[i].level <= n.level)) {
        body.push(nodes[i]); i++;
      }
      cards.push(qaCard(stripQuotes(n.text), renderBlocks(body), ++count));
      continue;
    }

    /* **Q1. 질문?**  →  답변  (부록 Q&A 형태 — 한 문단 안에 질문+답이 붙어 있다) */
    if (n.t === 'p') {
      const m = /^\*\*\s*Q\d+[.)]?\s*(?=\S)([\s\S]*?\S)\s*\*\*\s*[\n\s]*→\s*([\s\S]+)$/.exec(n.text.trim());
      if (m) {
        cards.push(qaCard(stripQuotes(m[1]), `<p>${inline(m[2].trim())}</p>`, ++count));
        i++;
        continue;
      }
    }

    /* - **"질문?"** — 답변 형태 (순서 없는 목록만 — 번호 목록은 절차/전략이라 그대로 둔다) */
    if (n.t === 'list' && !n.ordered) {
      let allQA = true;
      const made = [];
      for (const blocks of n.items) {
        const first = blocks[0];
        const m = first && first.t === 'p' &&
          /^\*\*(?=\S)([\s\S]*?\S)\*\*\s*[—–-]\s*([\s\S]+)$/.exec(first.text.trim());
        if (!m) { allQA = false; break; }
        const rest = blocks.slice(1);
        const ansHTML = `<p>${inline(m[2].trim())}</p>` + (rest.length ? renderBlocks(rest) : '');
        made.push({ q: stripQuotes(m[1]), a: ansHTML });
      }
      if (allQA && made.length) {
        made.forEach((x) => cards.push(qaCard(x.q, x.a, ++count)));
        i++;
        continue;
      }
    }

    out.push(renderBlocks([n]));
    i++;
  }

  const hint = cards.length
    ? '<p class="qa-hint">질문을 눌러 답을 펼쳐보세요 — 먼저 스스로 답해본 뒤 확인하면 훨씬 오래 남습니다.</p>'
    : '';
  return out.join('\n') + (cards.length ? hint + cards.join('\n') : '');
}

function qaCard(q, a, n) {
  return `<div class="qa">
<button class="qa-q" type="button"><span class="mk">Q${n}</span><span>${inline(q)}</span><span class="arw">▾</span></button>
<div class="qa-a">${a}</div>
</div>`;
}

/* =========================================================
   7. 문서 변환
   ========================================================= */
function buildDoc(md) {
  const blocks = parseBlocks(md);

  let title = '';
  let hero = null;
  const rest = [];

  for (const b of blocks) {
    if (!title && b.t === 'h' && b.level === 1) { title = b.text; continue; }
    if (!hero && b.t === 'quote') {
      const first = b.blocks.find((x) => x.t === 'p');
      if (first && /핵심\s*관전\s*포인트/.test(first.text)) {
        const cloned = b.blocks.map((x) => ({ ...x }));
        const ps = cloned.filter((x) => x.t === 'p');
        ps[0].text = ps[0].text.replace(/^\s*핵심\s*관전\s*포인트\s*[:：]?\s*/, '');

        /* 원문 히어로는 본문 전체를 **…** 로 감싼 경우가 많다.
           카드 자체가 이미 강조 스타일이라 바깥 볼드는 벗겨낸다.
           (안쪽에 중첩된 **…** 가 있으면 이걸 안 벗길 때 파싱이 깨진다) */
        const lastP = ps[ps.length - 1];
        if (/^\*\*\S/.test(ps[0].text) && /\S\*\*$/.test(lastP.text)) {
          ps[0].text = ps[0].text.slice(2);
          lastP.text = lastP.text.slice(0, -2);
        }
        hero = renderBlocks(cloned);
        continue;
      }
    }
    rest.push(b);
  }

  /* h2 기준으로 섹션 분할 */
  const prelude = [];
  const sections = [];
  let cur = null;
  for (const b of rest) {
    if (b.t === 'h' && b.level === 2) {
      cur = { rawTitle: b.text, blocks: [] };
      sections.push(cur);
    } else if (cur) {
      cur.blocks.push(b);
    } else if (b.t !== 'hr') {
      prelude.push(b);
    }
  }

  /* 마지막 hr 정리 */
  sections.forEach((s) => {
    while (s.blocks.length && s.blocks[s.blocks.length - 1].t === 'hr') s.blocks.pop();
    while (s.blocks.length && s.blocks[0].t === 'hr') s.blocks.shift();
  });

  /* 요약 섹션 분리 — '한 줄 요약' / '한 문장 결론' 둘 다,
     뒤에 '부록' 같은 섹션이 붙어 있어도 찾아낸다 */
  let summary = null;
  const sumIdx = sections.findIndex((s) => /한\s*(줄|문장)\s*(요약|결론)/.test(s.rawTitle));
  if (sumIdx >= 0) {
    summary = renderBlocks(sections.splice(sumIdx, 1)[0].blocks);
  }

  /* 섹션 렌더 */
  let auto = 0;
  const toc = [];
  const secHTML = sections.map((s, idx) => {
    const id = `sec-${idx + 1}`;
    const m = /^(\d+)\.\s*(.+)$/.exec(s.rawTitle);
    const num = m ? m[1] : String(++auto);
    const name = m ? m[2] : s.rawTitle;
    const isQA = /꼬리질문|Q&A|자주 헷갈리/.test(s.rawTitle);

    /* h3 하위 목차 (꼬리질문 섹션 제외, 2개 이상일 때만) */
    const h3s = s.blocks.filter((b) => b.t === 'h' && b.level === 3);
    const subOK = !isQA && h3s.length >= 2;
    const subIds = new Map();
    if (subOK) h3s.forEach((h, k) => subIds.set(h, `${id}-${k + 1}`));

    const body = isQA
      ? renderQA(s.blocks)
      : renderBlocks(s.blocks, { ids: (n) => subIds.get(n) || '' });

    toc.push({
      id, num, name,
      subs: subOK ? h3s.map((h) => ({ id: subIds.get(h), name: stripQuotes(h.text) })) : []
    });

    return `<section class="sec" id="${id}">
<div class="sec-head">
  <span class="sec-n">${esc(num)}</span>
  <h2>${inline(name)}</h2>
  <span class="sec-tools">
    <button class="chk" type="button" title="이해했으면 체크"></button>
    <span class="caret">▾</span>
  </span>
</div>
<div class="sec-body">
${body}
</div>
</section>`;
  }).join('\n');

  return {
    title: title || '(제목 없음)',
    hero,
    /* 줄바꿈으로 이어붙여야 plain() 의 줄 단위 인용부호(>) 제거가 매 줄에 걸린다.
       공백으로 합치면 한 줄이 되어 맨 앞 > 하나만 벗겨진다. */
    heroText: hero ? plain(md.split('\n').filter((l) => l.startsWith('>')).join('\n')) : '',
    prelude: prelude.length ? `<div class="sec-body prelude">${renderBlocks(prelude)}</div>` : '',
    sections: secHTML,
    summary,
    toc,
    secCount: sections.length
  };
}

/* =========================================================
   8. 페이지 템플릿
   ========================================================= */
const FAVICON = (hue) => 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="hsl(${hue},70%,45%)"/><path d="M9 22V10h4.6c3 0 4.7 1.4 4.7 3.6 0 1.6-.9 2.6-2.3 3l3.4 5.4h-3.3l-2.9-4.9h-1.2V22H9zm3-7.2h1.4c1.2 0 1.9-.5 1.9-1.5s-.7-1.4-1.9-1.4H12v2.9z" fill="#fff"/></svg>`);

function head(title, hue, root, extra = '') {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="icon" href="${FAVICON(hue)}">
<link rel="stylesheet" href="${root}assets/style.css">
${extra}`;
}

function docPage(d) {
  const root = d.root;
  const tocHTML = d.doc.toc.map((s) => {
    const subs = s.subs.length
      ? `<li class="sub"><ul class="toc">${s.subs.map((x) =>
          `<li><a href="#${x.id}"><span class="t">${esc(txt(x.name))}</span></a></li>`).join('')}</ul></li>`
      : '';
    return `<li><a href="#${s.id}"><span class="n">${esc(s.num)}</span><span class="t">${esc(txt(s.name))}</span></a></li>${subs}`;
  }).join('\n');

  const pager = [
    d.prev ? `<a class="prev" href="${root}${d.prev.path}"><span class="dir">← 이전</span><span class="ttl">${esc(txt(d.prev.title))}</span></a>` : '<span></span>',
    d.next ? `<a class="next" href="${root}${d.next.path}"><span class="dir">다음 →</span><span class="ttl">${esc(txt(d.next.title))}</span></a>` : '<span></span>'
  ].join('\n');

  return `<!doctype html>
<html lang="ko" data-root="${root}" data-doc="${esc(d.id)}" data-src="${esc(SRC_REL + '/' + d.rel)}" style="--hue:${d.hue}">
<head>
${head(txt(d.doc.title) + ' | knowledge-web', d.hue, root)}
</head>
<body class="page-doc">
<div class="scrim"></div>

<header class="topbar">
  <button class="icon-btn" id="menuBtn" type="button" title="목차">☰</button>
  <button class="icon-btn" id="backBtn" type="button" title="뒤로">←<span class="lbl">뒤로</span></button>
  <nav class="crumbs">
    <a href="${root}index.html">📚 전체</a>
    <span class="sep">/</span>
    <a href="${root}index.html#${esc(d.cat)}">${esc(d.catTitle)}</a>
    <span class="sep">/</span>
    <span class="cur">${esc(txt(d.doc.title).split(/\s+[—–-]\s+/)[0])}</span>
  </nav>
  <div class="topbar-actions">
    <button class="icon-btn" id="searchBtn" type="button" title="검색 (/)">🔍</button>
    <button class="icon-btn" id="foldBtn" type="button" title="모든 섹션 접기/펼치기">⇕<span class="lbl">모두 접기</span></button>
    <button class="icon-btn" id="testBtn" type="button" title="셀프테스트 모드 (s)">🎯<span class="lbl">셀프테스트</span></button>
    <button class="icon-btn" id="bmBtn" type="button" title="복습 목록 (b)">🏷️</button>
    <button class="icon-btn" id="themeBtn" type="button" title="테마 (t)">🌙</button>
    <button class="icon-btn" id="pathBtn" type="button" title="파일 경로 복사">📋<span class="lbl">경로 복사</span></button>
  </div>
</header>
<div class="progress"><i></i></div>

<div class="layout">
  <aside class="sidebar">
    <p class="side-title">목차</p>
    <ul class="toc">
${tocHTML}
    </ul>
    <div class="side-foot">
      <kbd>j</kbd><kbd>k</kbd> 섹션 이동<br>
      <kbd>s</kbd> 셀프테스트 · <kbd>b</kbd> 복습표시<br>
      <kbd>/</kbd> 검색 · <kbd>t</kbd> 테마 · <kbd>h</kbd> 홈<br>
      <kbd>⌫</kbd> 뒤로 (보던 문서·위치로)
    </div>
  </aside>

  <main class="content">
    <div class="doc-head">
      <span class="cat-chip">${esc(d.catTitle)}</span>
      <h1>${inline(d.doc.title)}</h1>
      <div class="doc-meta">
        <span>📖 약 <b>${d.minutes}분</b></span>
        <span>🧩 <b>${d.doc.secCount}</b>개 섹션</span>
        <span class="ring" id="progRing"><i></i><span id="progLabel">0/${d.doc.secCount} 섹션 이해</span></span>
      </div>
    </div>

${d.doc.hero ? `    <section class="hero maskable">
      <div class="hero-label"><span>🎯 핵심 관전 포인트</span><button class="mask-btn" type="button">🙈 가리기</button></div>
      <div class="hero-body">${d.doc.hero}</div>
    </section>` : ''}

${d.doc.prelude}

${d.doc.sections}

${d.doc.summary ? `    <section class="summary maskable">
      <div class="summary-l"><span>✅ 한 줄 요약</span><button class="mask-btn" type="button">🙈 가리기</button></div>
      <div class="mask-target">${d.doc.summary}</div>
    </section>` : ''}

    <nav class="pager">
${pager}
    </nav>

    <p class="src-link">원본: <code>knowledge/${esc(d.rel)}</code></p>
  </main>
</div>

<script src="${root}assets/data.js"></script>
<script src="${root}assets/app.js"></script>
</body>
</html>`;
}

function indexPage(cats, docs) {
  const catHTML = cats.map((c) => {
    const list = docs.filter((d) => d.cat === c.dir);
    const cards = list.map((d) => `      <a class="card" data-id="${esc(d.id)}" href="${esc(d.path)}">
        <span class="bm"></span>
        <span class="t">${esc(txt(d.title))}</span>
        <span class="d">${esc(d.summary)}</span>
        <span class="f"><span class="pill pg">0/${d.secCount} 섹션</span><span>📖 ${d.minutes}분</span></span>
      </a>`).join('\n');

    return `  <section class="cat${list.length ? '' : ' empty'}" id="${esc(c.dir)}" style="--hue:${c.hue}">
    <div class="cat-h">
      <span class="dot"></span>
      <h2>${esc(c.title)}</h2>
      <span class="cnt">${list.length}개</span>
    </div>
    <div class="cardgrid">
${cards || '      <p class="empty-msg" style="grid-column:1/-1;padding:20px">아직 문서가 없습니다.</p>'}
    </div>
  </section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="ko" data-root="" data-src="${esc(OUT_REL + '/index.html')}" style="--hue:212">
<head>
${head('knowledge-web — 백엔드 지식 학습 문서', 212, '')}
</head>
<body class="page-home">

<header class="topbar">
  <nav class="crumbs"><span class="cur">📚 knowledge-web</span></nav>
  <div class="topbar-actions">
    <button class="icon-btn" id="searchBtn" type="button" title="검색 (/)">🔍<span class="lbl">검색</span></button>
    <button class="icon-btn" id="resetBtn" type="button" title="진도 초기화">↺<span class="lbl">진도 초기화</span></button>
    <button class="icon-btn" id="themeBtn" type="button" title="테마 (t)">🌙</button>
    <button class="icon-btn" id="pathBtn" type="button" title="파일 경로 복사">📋<span class="lbl">경로 복사</span></button>
  </div>
</header>

<main class="home">
  <div class="hero-home">
    <h1>지식을 담금질하다 🔥</h1>
    <p><code>knowledge/</code> 의 학습 문서를 읽기 쉽고 오래 기억되도록 다시 만든 웹 버전입니다.
       섹션마다 이해 여부를 체크하고, 셀프테스트 모드로 요약과 꼬리질문 답을 가린 채 스스로 떠올려보세요.</p>
  </div>

  <div class="stats">
    <div class="stat"><div class="v" id="stDocs">0</div><div class="k">전체 문서</div></div>
    <div class="stat"><div class="v" id="stDone">0</div><div class="k">완독한 문서</div></div>
    <div class="stat"><div class="v" id="stBm">0</div><div class="k">🔖 복습 목록</div></div>
    <div class="stat">
      <div class="v" id="stPct">0%</div><div class="k">전체 진도</div>
      <div class="bar"><i id="stBar"></i></div>
    </div>
  </div>

  <div class="home-search">
    <span>🔍</span>
    <input id="homeSearch" type="text" placeholder="문서 · 주제 · 키워드로 검색" autocomplete="off" spellcheck="false">
  </div>

  <div class="chips">
    <button class="chip on" data-mode="all" type="button">전체</button>
    <button class="chip" data-mode="todo" type="button">아직 안 본 것</button>
    <button class="chip" data-mode="done" type="button">완독</button>
    <button class="chip" data-mode="bm" type="button">🔖 복습 목록</button>
  </div>

  <p class="empty-msg" id="emptyMsg" style="display:none">조건에 맞는 문서가 없습니다.</p>

${catHTML}
</main>

<script src="assets/data.js"></script>
<script src="assets/app.js"></script>
</body>
</html>`;
}

/* =========================================================
   9. 실행
   ========================================================= */
function walk(dir, base = '') {
  const res = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? path.posix.join(base, e.name) : e.name;
    if (e.isDirectory()) res.push(...walk(path.join(dir, e.name), rel));
    else if (e.name.endsWith('.md')) res.push(rel);
  }
  return res;
}

/* knowledge/README.md 의 표에서 카테고리 이름을 읽어온다 */
function readCats() {
  const titles = new Map();
  const readme = path.join(SRC, 'README.md');
  if (fs.existsSync(readme)) {
    for (const line of fs.readFileSync(readme, 'utf8').split('\n')) {
      const m = /^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
      if (m) titles.set(m[1].trim(), m[2].trim());
    }
  }

  /* 카테고리 목록의 기준은 README 의 표다. git 은 빈 디렉토리를 추적하지 않아서
     디스크만 훑으면 아직 문서가 없는 카테고리가 클론에서 통째로 사라진다.
     표에 없는 디렉토리는 뒤에 합쳐 새로 만든 카테고리도 놓치지 않는다. */
  const onDisk = fs.readdirSync(SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  const dirs = [...new Set([...titles.keys(), ...onDisk])].sort();

  return dirs.map((dir) => ({
    dir,
    title: titles.get(dir) || dir.replace(/^\d+-/, '').replace(/-/g, ' '),
    hue: HUES[dir] ?? 212
  }));
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`✗ 원본 디렉토리가 없습니다: ${SRC}`);
    process.exit(1);
  }

  const cats = readCats();
  const catMap = new Map(cats.map((c) => [c.dir, c]));
  const files = walk(SRC).sort();

  /* 1차: 링크 맵 구성 (파일명.md → 상대 html 경로) */
  LINK_MAP = new Map();
  for (const rel of files) {
    const name = path.posix.basename(rel);
    if (name === 'README.md') continue;
    LINK_MAP.set(name, rel.replace(/\.md$/, '.html'));
  }

  /* 카테고리 디렉토리 전부 생성 (빈 카테고리도 구조를 맞춘다) */
  for (const c of cats) fs.mkdirSync(path.join(OUT, c.dir), { recursive: true });

  /* 2차: 문서 메타 수집 */
  const entries = files.map((rel) => {
    const md = fs.readFileSync(path.join(SRC, rel), 'utf8');
    const dir = path.posix.dirname(rel);
    const cat = dir === '.' ? '' : dir;
    const c = catMap.get(cat);
    const depth = rel.split('/').length - 1;
    CUR_ROOT = '../'.repeat(depth);
    const doc = buildDoc(md);
    const body = plain(md);
    return {
      rel,
      id: rel.replace(/\.md$/, ''),
      path: rel.replace(/\.md$/, '.html'),
      cat,
      root: CUR_ROOT,
      catTitle: c ? c.title : '개요',
      hue: c ? c.hue : 212,
      doc,
      minutes: Math.max(1, Math.round(body.length / 500)),
      summary: (doc.heroText || body).slice(0, 190)
    };
  });

  /* 이전/다음 */
  entries.forEach((e, i) => {
    e.prev = i > 0 ? entries[i - 1] : null;
    e.next = i < entries.length - 1 ? entries[i + 1] : null;
  });

  /* 3차: 렌더 */
  for (const e of entries) {
    const outPath = path.join(OUT, e.path);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, docPage({
      ...e,
      prev: e.prev && { path: e.prev.path, title: e.prev.doc.title },
      next: e.next && { path: e.next.path, title: e.next.doc.title }
    }), 'utf8');
  }

  /* data.js — 검색·통계용 */
  const data = entries.map((e) => ({
    id: e.id, path: e.path, cat: e.cat, catTitle: e.catTitle,
    title: txt(e.doc.title), summary: e.summary,
    secCount: e.doc.secCount, minutes: e.minutes,
    secs: e.doc.toc.map((t) => txt(t.name))
  }));
  fs.writeFileSync(path.join(OUT, 'assets', 'data.js'),
    '/* 자동 생성 — build.mjs */\nwindow.KW_DOCS = ' + JSON.stringify(data, null, 0) + ';\n', 'utf8');

  /* index.html — 카드가 쓰는 필드(title·secCount 등)는 entries 에서 doc 아래에
     있으므로 entries 를 그대로 넘기면 undefined 가 된다. 위에서 만든 평평한
     data 를 그대로 재사용해 클라이언트(data.js)와 카드가 같은 모양을 보게 한다. */
  const home = data.filter((e) => e.cat);
  fs.writeFileSync(path.join(OUT, 'index.html'), indexPage(cats, home), 'utf8');

  const rootDocs = entries.filter((e) => !e.cat).map((e) => e.path);
  console.log(`✓ ${entries.length}개 문서 → HTML  (카테고리 ${cats.length}개)`);
  if (rootDocs.length) console.log(`  루트 문서: ${rootDocs.join(', ')}`);
  console.log(`✓ index.html · assets/data.js 생성 완료`);
  console.log(`\n브라우저에서 열기:\n  open ${path.join(OUT, 'index.html')}`);
}

main();
