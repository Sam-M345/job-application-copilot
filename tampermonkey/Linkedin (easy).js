// ==UserScript==
// @name         Linkedin (Easy Apply)
// @namespace    job-fill-linkedin
// @version      3.41
// @description  LinkedIn-only build. Fills LinkedIn job applications using Claude AI + your Knowledge Base + resume + AI instructions, scraping the job description so open-ended answers are tailored to the role.
// @match        https://www.linkedin.com/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.anthropic.com
// @connect      cdnjs.cloudflare.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js
// ==/UserScript==

(function () {
  'use strict';

  // ─── Profile ──────────────────────────────────────────────────────────────
  // No personal data is hardcoded. These direct-map fields fall back to the
  // Knowledge Base (and Claude) when blank, so each user supplies their own info
  // via the Knowledge Base button — nothing identifying ships in this script.
  const PROFILE = {
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    location: '',
    linkedin: '',
    github: '',
    portfolio: '',
  };

  // ─── Knowledge Base (single source of truth — stored in GM, editable via UI) ─
  // Ships EMPTY by design: no personal data is baked into this script. On first
  // install the Knowledge Base starts blank; each user enters their own info via
  // the Knowledge Base button, and it persists in GM storage from then on.
  const DEFAULT_KNOWLEDGE = '';

  // Seed GM storage only if it is completely empty (true first install).
  // If the user already has content saved, never overwrite it.
  if (!GM_getValue('kb_seeded', false)) {
    if (!GM_getValue('user_knowledge', '').trim()) {
      GM_setValue('user_knowledge', DEFAULT_KNOWLEDGE);
    }
    GM_setValue('kb_seeded', true);
  }

  function getUserKnowledge() {
    return GM_getValue('user_knowledge', DEFAULT_KNOWLEDGE);
  }

  function saveUserKnowledge(text) {
    GM_setValue('user_knowledge', text);
  }

  function getAiInstructions() {
    return GM_getValue('ai_instructions', '');
  }

  function saveAiInstructions(text) {
    GM_setValue('ai_instructions', text);
  }

  function buildAiInstructionsBlock() {
    const instructions = getAiInstructions().trim();
    if (!instructions) return '';
    return `\nAdditional instructions from the candidate (follow these when answering):\n${instructions}\n`;
  }

  // ─── Resume (shared GM storage with Greenhouse build) ───────────────────────
  const MAX_RESUME_BYTES = 4 * 1024 * 1024;
  const MAX_RESUME_TEXT_CHARS = 20000;

  function getResumeMeta() {
    return {
      name: GM_getValue('resume_file_name', ''),
      type: GM_getValue('resume_file_type', 'application/pdf'),
      data: GM_getValue('resume_file_data', ''),
      text: GM_getValue('resume_text', ''),
    };
  }

  function hasResumeFile() {
    const meta = getResumeMeta();
    return !!(meta.name && meta.data);
  }

  async function gmSet(key, value) {
    const ret = GM_setValue(key, value);
    if (ret && typeof ret.then === 'function') await ret;
  }

  async function saveResumeFile({ name, type, data, text }) {
    await gmSet('resume_file_name', name);
    await gmSet('resume_file_type', type || 'application/octet-stream');
    await gmSet('resume_file_data', data);
    await gmSet('resume_text', text || '');
    if (!hasResumeFile()) {
      throw new Error('Resume failed to persist — file may be too large for browser storage');
    }
  }

  function buildResumeContextBlock() {
    const text = (getResumeMeta().text || '').trim();
    if (!text) return '';
    return `\nCandidate resume (use for experience, skills, employers, education, and open-ended answers):\n${text.slice(0, MAX_RESUME_TEXT_CHARS)}\n`;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error('file read failed'));
      reader.readAsDataURL(file);
    });
  }

  function resumeBytesToFile(meta) {
    const binary = atob(meta.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], meta.name, { type: meta.type || 'application/octet-stream' });
  }

  async function extractPdfText(arrayBuffer) {
    if (typeof pdfjsLib === 'undefined') return '';
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const chunks = [];
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const content = await page.getTextContent();
        chunks.push(content.items.map(item => item.str).join(' '));
      }
      return chunks.join('\n').replace(/\s+/g, ' ').trim();
    } catch (e) {
      console.warn('[resume] PDF text extraction failed', e);
      return '';
    }
  }

  async function extractResumeText(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.txt') || name.endsWith('.md')) {
      return (await file.text()).trim();
    }
    if (name.endsWith('.pdf') || file.type === 'application/pdf') {
      return await extractPdfText(await file.arrayBuffer());
    }
    return '';
  }

  function getLinkedInApplyRoots() {
    const roots = [];
    for (const sel of [
      '.jobs-easy-apply-modal',
      '[data-test-modal-id="easy-apply-modal"]',
      '.jobs-easy-apply-content',
      '.artdeco-modal',
    ]) {
      const el = document.querySelector(sel);
      if (el && !roots.includes(el)) roots.push(el);
    }
    return roots.length ? roots : [document];
  }

  function findResumeFileInput() {
    const scoreInput = (el) => {
      const label = (
        el.getAttribute('aria-label') ||
        el.closest('label')?.innerText ||
        el.parentElement?.innerText ||
        ''
      ).toLowerCase();
      const id = (el.id || '').toLowerCase();
      const name = (el.name || '').toLowerCase();
      const combined = `${label} ${id} ${name}`;
      let score = 0;
      if (/resume|curriculum|cv\b/.test(combined)) score += 20;
      if ((el.getAttribute('accept') || '').toLowerCase().includes('pdf')) score += 5;
      return score;
    };

    let best = null;
    let bestScore = -1;
    for (const root of getLinkedInApplyRoots()) {
      for (const el of root.querySelectorAll('input[type="file"]')) {
        const score = scoreInput(el);
        if (score > bestScore) {
          best = el;
          bestScore = score;
        } else if (!best) {
          best = el;
          bestScore = score;
        }
      }
    }
    return best;
  }

  let resumeAttachPendingUntil = 0;

  // LinkedIn clears/replaces the <input type="file"> after upload but keeps a file card
  // ("Uploaded on …") in the modal — checking input.files alone causes re-attach loops.
  function linkedInResumeDisplayedOnForm() {
    const meta = getResumeMeta();
    for (const root of getLinkedInApplyRoots()) {
      const text = root.innerText || '';
      const lower = text.toLowerCase();
      if (!/\bresume\b/.test(lower) || !/uploaded on/i.test(text)) continue;
      if (/\.(pdf|docx?|txt)\b/i.test(text)) return true;
      if (meta.name && text.includes(meta.name)) return true;
    }
    return false;
  }

  function resumeAlreadyAttached(input) {
    if (linkedInResumeDisplayedOnForm()) {
      resumeAttachPendingUntil = 0;
      return true;
    }
    try {
      return !!(input?.files && input.files.length > 0);
    } catch {
      return false;
    }
  }

  async function attachResumeToForm({ silent = false } = {}) {
    const meta = getResumeMeta();
    if (!meta.name || !meta.data) {
      if (!silent) showToast('No resume saved — click Resume to choose a file.');
      return false;
    }

    const input = findResumeFileInput();
    if (!input) {
      if (!silent) showToast('Open Easy Apply first — no resume upload field found.');
      return false;
    }
    if (resumeAlreadyAttached(input)) {
      if (!silent) showToast('Resume already attached.');
      updateResumeWidgetUI();
      return true;
    }

    try {
      const file = resumeBytesToFile(meta);
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      resumeAttachPendingUntil = Date.now() + 15000;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (!silent) showToast(`Resume attached: ${meta.name}`);
      updateResumeWidgetUI();
      return true;
    } catch (e) {
      console.error('[resume] attach failed', e);
      if (!silent) showToast('Resume attach failed — see console');
      return false;
    }
  }

  async function clearResumeFile() {
    await gmSet('resume_file_name', '');
    await gmSet('resume_file_type', '');
    await gmSet('resume_file_data', '');
    await gmSet('resume_text', '');
    updateResumeWidgetUI();
  }

  function isResumeAttachedOnPage() {
    const input = findResumeFileInput();
    return !!(input && resumeAlreadyAttached(input));
  }

  function truncateResumeName(name, max = 22) {
    if (!name || name.length <= max) return name || '';
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    const baseMax = Math.max(8, max - ext.length - 1);
    return name.slice(0, baseMax) + '…' + ext;
  }

  function updateResumeWidgetUI() {
    const btn = document.getElementById('jaf-resume-btn');
    const icon = document.getElementById('jaf-resume-icon');
    const label = document.getElementById('jaf-resume-label');
    const status = document.getElementById('jaf-resume-status');
    const actions = document.getElementById('jaf-resume-actions');
    if (!btn || !icon || !label || !status || !actions) return;

    const meta = getResumeMeta();
    const saved = !!(meta.name && meta.data);
    const onPage = saved && isResumeAttachedOnPage();

    if (saved) {
      icon.textContent = onPage ? '✓' : '📎';
      icon.style.color = onPage ? '#15803d' : '#b45309';
      label.textContent = truncateResumeName(meta.name);
      btn.style.borderColor = onPage ? '#16a34a' : '#d97706';
      btn.style.background = onPage ? 'rgba(220, 252, 231, 0.85)' : 'rgba(255, 251, 235, 0.95)';
      status.textContent = onPage
        ? 'Attached on this form'
        : (meta.text ? `Saved · ${meta.text.length} chars for AI` : 'Saved · upload only');
      status.style.color = onPage ? '#15803d' : '#78716c';
      actions.style.display = 'flex';
      btn.title = `${meta.name} — click to replace or attach in Easy Apply`;
    } else {
      icon.textContent = '📄';
      icon.style.color = '#9a3412';
      label.textContent = 'Resume';
      btn.style.borderColor = '#d97706';
      btn.style.background = 'transparent';
      status.textContent = 'No resume saved';
      status.style.color = '#78716c';
      actions.style.display = 'none';
      btn.title = 'Choose your resume (PDF recommended). Attaches to Easy Apply and feeds Claude.';
    }
  }

  function pickResumeFile() {
    return new Promise(resolve => {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = '.pdf,.doc,.docx,.txt,.md,application/pdf';
      picker.style.display = 'none';
      picker.addEventListener('change', async () => {
        const file = picker.files?.[0];
        picker.remove();
        if (!file) {
          resolve(null);
          return;
        }
        if (file.size > MAX_RESUME_BYTES) {
          showToast('Resume too large — max 4 MB.');
          resolve(null);
          return;
        }
        try {
          showToast('Saving resume…');
          const [data, text] = await Promise.all([
            fileToBase64(file),
            extractResumeText(file),
          ]);
          await saveResumeFile({ name: file.name, type: file.type, data, text });
          updateResumeWidgetUI();
          showToast(text
            ? `Resume saved — ${text.length} chars extracted for AI`
            : `Resume saved (${file.name}) — upload only; use PDF for AI text`);
          resolve({ name: file.name, text });
        } catch (e) {
          console.error('[resume] save failed', e);
          showToast('Resume save failed — see console');
          resolve(null);
        }
      });
      document.body.appendChild(picker);
      picker.click();
    });
  }

  async function handleResumeButtonClick() {
    if (!hasResumeFile()) {
      await pickResumeFile();
      return;
    }
    const input = findResumeFileInput();
    if (input && !resumeAlreadyAttached(input)) {
      await attachResumeToForm({ silent: false });
      return;
    }
    await pickResumeFile();
  }

  function handleResumeDeleteClick() {
    if (!hasResumeFile()) return;
    clearResumeFile();
    showToast('Resume removed');
  }

  // Normalize a question/key for comparison: lowercase, collapse whitespace,
  // and strip a trailing colon. Field labels often end in ":" (e.g. "specify
  // here:"); without stripping it, the stored "label: value" line splits at the
  // label's own colon and the parsed key never equals the lookup question.
  function normalizeKey(s) {
    return String(s).toLowerCase().trim().replace(/[:：]+\s*$/, '').replace(/\s+/g, ' ').trim();
  }

  // Build a single-colon "Key: Value" entry, stripping any trailing colon from
  // the question so labels ending in ":" don't produce a doubled "::".
  function formatKbEntry(question, answer) {
    const cleanQ = String(question).replace(/[:：]+\s*$/, '').trim();
    return `${cleanQ}: ${answer}`;
  }

  // Upsert: if a line with the same question key already exists, replace its
  // value in place. Otherwise append a new entry. This prevents duplicate keys
  // (e.g. two "Degree:" lines) where a stale first entry shadows a corrected one.
  function appendToUserKnowledge(question, answer) {
    const existing = getUserKnowledge();
    const qNorm = normalizeKey(question);
    const lines = existing.split('\n');
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx < 1) continue;
      const key = normalizeKey(trimmed.slice(0, colonIdx));
      if (key === qNorm) {
        lines[i] = formatKbEntry(question, answer);
        replaced = true;
        break;
      }
    }
    if (replaced) {
      saveUserKnowledge(lines.join('\n'));
      return;
    }
    const entry = `\n\n\n${formatKbEntry(question, answer)}`;
    saveUserKnowledge(existing + entry);
  }

  function buildFullKnowledge() {
    return getUserKnowledge();
  }

  // ─── Job description scrape (LinkedIn only) ─────────────────────────────────
  // Lets Claude tailor open-ended answers (why interested, fit, cover letters)
  // to the actual role. Selectors confirmed live across both LinkedIn layouts:
  //   /jobs/view/   → [data-testid="expandable-text-box"]
  //   /jobs/search/ → #job-details / .jobs-description__content
  // Other sites (greenhouse, lever, …) return '' → Claude falls back to a
  // generic answer, exactly as before. Capped at 20000 chars (~5k tokens) so even
  // unusually long postings fit in full — typical LinkedIn descriptions run
  // ~5–10k chars. Returns '' when no description is present (e.g. bare apply pages).
  function getJobDescription() {
    if (!/(^|\.)linkedin\.com$/.test(location.hostname)) return '';
    const selectors = [
      '[data-testid="expandable-text-box"]',
      '[data-sdui-component*="aboutTheJob"]',
      '#job-details',
      '.jobs-description__content',
      '.jobs-box__html-content',
      '.jobs-description-content__text',
      '.show-more-less-html__markup',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const text = (el.innerText || '').trim();
        if (text.length > 100) return text.slice(0, 20000);
      }
    }
    return '';
  }

  function getJobTitle() {
    const selectors = [
      '.job-details-jobs-unified-top-card__job-title',
      '.jobs-unified-top-card__job-title',
      '[data-testid="job-title"]',
      'h1.t-24',
      'h1',
    ];
    for (const sel of selectors) {
      const text = document.querySelector(sel)?.innerText?.trim();
      if (text && text.length > 1 && text.length < 200) return text;
    }
    return '';
  }

  function getCompanyName() {
    const selectors = [
      '.job-details-jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__company-name',
      '[data-testid="job-company-name"]',
      'a.job-details-jobs-unified-top-card__company-name',
    ];
    for (const sel of selectors) {
      const text = document.querySelector(sel)?.innerText?.trim();
      if (text && text.length > 1 && text.length < 120) return text;
    }
    return '';
  }

  function sanitizeFilenamePart(s) {
    return String(s || '').replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'job';
  }

  function sanitizeCoverLetterFilenamePart(s) {
    return String(s || '').trim().replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  }

  function looksLikePlainPersonName(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 80 || t.includes(':')) return false;
    if (/[@#]|https?:|\.(com|org|edu|io)\b|\(\d{3}\)|\d{3}[-.)]\d{3}/i.test(t)) return false;
    const parts = t.split(/\s+/).filter(Boolean);
    if (parts.length < 2 || parts.length > 4) return false;
    return parts.every(p => /^[A-Za-z][A-Za-z'.-]*$/.test(p));
  }

  function parsePlainNameFromKnowledge() {
    const kb = buildFullKnowledge();
    let checked = 0;
    for (const line of kb.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('---')) break;
      if (trimmed.includes(':')) continue;
      if (looksLikePlainPersonName(trimmed)) {
        const parts = trimmed.split(/\s+/).filter(Boolean);
        return { first: parts[0], last: parts.slice(1).join(' ') };
      }
      checked++;
      if (checked >= 10) break;
    }

    const resumeName = getResumeMeta().name || '';
    const resumeMatch = resumeName.match(/(?:^|[^A-Za-z])([A-Z][a-z]+)[_-]([A-Z][a-z]+)(?:[^A-Za-z]|$)/);
    if (resumeMatch) {
      return { first: resumeMatch[1], last: resumeMatch[2] };
    }

    return { first: '', last: '' };
  }

  function findKbExactKey(key) {
    const qNorm = normalizeKey(key);
    for (const line of buildFullKnowledge().split('\n')) {
      const trimmed = line.trim();
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx < 1) continue;
      if (normalizeKey(trimmed.slice(0, colonIdx)) === qNorm) {
        return trimmed.slice(colonIdx + 1).replace(/^:+\s*/, '').trim();
      }
    }
    return '';
  }

  function getCandidateNameParts() {
    let first = (PROFILE.first_name || '').trim();
    let last = (PROFILE.last_name || '').trim();
    if (!first) first = (directValue('First name') || findKbExactKey('First name') || '').trim();
    if (!last) last = (directValue('Last name') || findKbExactKey('Last name') || '').trim();
    if (!first || !last) {
      const full = (
        directValue('Full name') ||
        directValue('Your name') ||
        findKbExactKey('Full name') ||
        findKbExactKey('Name') ||
        ''
      ).trim();
      if (full) {
        const parts = full.split(/\s+/).filter(Boolean);
        if (!first && parts[0]) first = parts[0];
        if (!last && parts.length > 1) last = parts.slice(1).join(' ');
      }
    }
    if (!first || !last) {
      const parsed = parsePlainNameFromKnowledge();
      if (!first && parsed.first) first = parsed.first;
      if (!last && parsed.last) last = parsed.last;
    }
    return { first, last };
  }

  function sanitizeDocxPlainText(text) {
    return String(text || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  function escapeXmlForDocx(text) {
    return sanitizeDocxPlainText(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function buildDocxDocumentXml(text) {
    const normalized = String(text || '').replace(/\r\n/g, '\n');
    const blocks = normalized.split(/\n\n+/);
    const paragraphs = [];
    for (const block of blocks) {
      if (!block.trim()) {
        paragraphs.push('<w:p/>');
        continue;
      }
      for (const line of block.split('\n')) {
        const escaped = escapeXmlForDocx(line);
        paragraphs.push(`<w:p><w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>`);
      }
    }
    if (!paragraphs.length) paragraphs.push('<w:p/>');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.join('\n    ')}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;
  }

  function clDlLog(step, detail) {
    const ts = new Date().toISOString().slice(11, 23);
    if (detail !== undefined) console.log(`[cover-letter-dl ${ts}] ${step}`, detail);
    else console.log(`[cover-letter-dl ${ts}] ${step}`);
  }

  function overlayFocusGuard(overlay, e) {
    const inOverlay = (node) => node instanceof Node && overlay.contains(node);
    if (inOverlay(e.target) || inOverlay(e.relatedTarget)) e.stopPropagation();
  }

  const JAF_DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  function clDlWithTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    if (!crc32.table) {
      crc32.table = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        crc32.table[i] = c;
      }
    }
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ crc32.table[(crc ^ bytes[i]) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
  }

  function getDocxZipEntries(text) {
    const encoder = new TextEncoder();
    const documentXml = buildDocxDocumentXml(text);
    return [
      { name: '[Content_Types].xml', data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`) },
      { name: '_rels/.rels', data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`) },
      { name: 'word/document.xml', data: encoder.encode(documentXml) },
      { name: 'word/_rels/document.xml.rels', data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`) },
    ];
  }

  function buildDocxStoreZipBlob(text) {
    const entries = getDocxZipEntries(text);
    const chunks = [];
    const cdEntries = [];
    let offset = 0;

    for (const entry of entries) {
      const nameBytes = entry.name instanceof Uint8Array ? entry.name : new TextEncoder().encode(entry.name);
      const data = entry.data;
      const entryCrc = crc32(data);
      const size = data.length;
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(localHeader.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(8, 0, true);
      dv.setUint32(14, entryCrc, true);
      dv.setUint32(18, size, true);
      dv.setUint32(22, size, true);
      dv.setUint16(26, nameBytes.length, true);
      localHeader.set(nameBytes, 30);
      chunks.push(localHeader, data);
      cdEntries.push({ nameBytes, crc: entryCrc, size, offset });
      offset += localHeader.length + data.length;
    }

    const cdStart = offset;
    for (const e of cdEntries) {
      const cd = new Uint8Array(46 + e.nameBytes.length);
      const dv = new DataView(cd.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint32(16, e.crc, true);
      dv.setUint32(20, e.size, true);
      dv.setUint32(24, e.size, true);
      dv.setUint16(28, e.nameBytes.length, true);
      dv.setUint32(42, e.offset, true);
      cd.set(e.nameBytes, 46);
      chunks.push(cd);
      offset += cd.length;
    }

    const cdSize = offset - cdStart;
    const end = new Uint8Array(22);
    const edv = new DataView(end.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, cdEntries.length, true);
    edv.setUint16(10, cdEntries.length, true);
    edv.setUint32(12, cdSize, true);
    edv.setUint32(16, cdStart, true);
    chunks.push(end);

    const total = chunks.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const part of chunks) {
      out.set(part, pos);
      pos += part.length;
    }
    return new Blob([out], { type: JAF_DOCX_MIME });
  }

  function buildDocxBlob(text) {
    clDlLog('strategy-native-store-zip');
    const t0 = performance.now();
    const blob = buildDocxStoreZipBlob(text);
    clDlLog('zip-generate-done', { bytes: blob.size, ms: Math.round(performance.now() - t0) });
    return blob;
  }

  async function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error || new Error('blob read failed'));
      reader.readAsDataURL(blob);
    });
  }

  function logSaveWindowExpectation(method, saveDialogExpected, extra) {
    clDlLog('SAVE-WINDOW', {
      saveDialogExpected,
      method,
      osDialogDetectableFromJs: false,
      note: saveDialogExpected
        ? 'Tampermonkey GM_download(saveAs:true) should open Windows Save As — JS cannot detect if it appeared or user clicked Save'
        : 'Anchor download — no Windows Save As dialog; file goes to browser default Downloads if allowed',
      ...extra,
    });
  }

  function waitForPageDownloadAck(timeoutMs) {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        document.removeEventListener('jaf-cover-letter-dl', handler);
        resolve({ ack: false, reason: 'timeout-no-page-ack' });
      }, timeoutMs);
      function handler(e) {
        clearTimeout(timer);
        document.removeEventListener('jaf-cover-letter-dl', handler);
        resolve({ ack: true, detail: e.detail || {} });
      }
      document.addEventListener('jaf-cover-letter-dl', handler);
    });
  }

  function downloadBlobInPageContext(blob, filename) {
    return blobToBase64(blob).then(base64 => new Promise((resolve, reject) => {
      if (typeof unsafeWindow === 'undefined') {
        reject(new Error('unsafeWindow unavailable for page-context download'));
        return;
      }
      const token = `jaf_blob_dl_${Date.now()}`;
      unsafeWindow[token] = { base64, filename, mime: JAF_DOCX_MIME };
      logSaveWindowExpectation('page-context-anchor', false, { filename });
      const ackPromise = waitForPageDownloadAck(3000);
      const scriptBody = `(function(){
        var token = ${JSON.stringify(token)};
        var emit = function(detail) {
          try { document.dispatchEvent(new CustomEvent('jaf-cover-letter-dl', { detail: detail })); } catch (_) {}
        };
        try {
          var p = window[token];
          delete window[token];
          if (!p) throw new Error('payload missing');
          var bin = atob(p.base64);
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          var blob = new Blob([bytes], { type: p.mime });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = p.filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          emit({ stage: 'anchor-clicked', filename: p.filename, saveDialogExpected: false });
          setTimeout(function() { URL.revokeObjectURL(url); }, 2000);
        } catch (e) {
          emit({ stage: 'error', message: String(e && e.message ? e.message : e) });
          console.error('[cover-letter-dl:page] download failed', e);
        }
      })();`;
      const scriptUrl = URL.createObjectURL(new Blob([scriptBody], { type: 'application/javascript' }));
      const inj = document.createElement('script');
      inj.src = scriptUrl;
      inj.onload = () => {
        URL.revokeObjectURL(scriptUrl);
        inj.remove();
      };
      inj.onerror = () => {
        URL.revokeObjectURL(scriptUrl);
        inj.remove();
        reject(new Error('page-context download script blocked (CSP)'));
      };
      (document.documentElement || document.head || document.body).appendChild(inj);
      ackPromise.then(ack => {
        clDlLog('download-page-context-ack', ack);
        if (!ack.ack) {
          reject(new Error('page-context anchor ack timeout'));
          return;
        }
        if (ack.detail?.stage === 'error') {
          reject(new Error(ack.detail.message || 'page-context anchor failed'));
          return;
        }
        clDlLog('VERDICT', {
          scriptPath: 'page-context',
          pageAck: true,
          anchorClicked: ack.detail?.stage === 'anchor-clicked',
          fileSavedOnDisk: 'unknown-check-downloads-folder',
        });
        resolve({ method: 'page-context', saveDialogExpected: false, pageAck: true, fileSavedOnDisk: 'unknown' });
      });
    }));
  }

  function downloadBlobViaSandboxAnchor(blob, filename) {
    clDlLog('download-via-anchor');
    logSaveWindowExpectation('sandbox-anchor', false, { filename });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    clDlLog('VERDICT', {
      scriptPath: 'sandbox-anchor',
      anchorClicked: true,
      saveDialogExpected: false,
      fileSavedOnDisk: 'unknown-check-downloads-folder',
    });
    clDlLog('download-anchor-done');
    return { method: 'sandbox-anchor', saveDialogExpected: false, fileSavedOnDisk: 'unknown' };
  }

  async function triggerBlobDownload(blob, filename) {
    if (typeof GM_download === 'function') {
      const blobUrl = URL.createObjectURL(blob);
      try {
        clDlLog('download-via-gm', { bytes: blob.size, filename });
        logSaveWindowExpectation('GM_download', true, { saveAs: true, filename, urlType: 'blob' });
        const gmResult = await clDlWithTimeout(new Promise((resolve, reject) => {
          GM_download({
            url: blobUrl,
            name: filename,
            saveAs: true,
            onload: (e) => {
              clDlLog('gm-download-onload', {
                saveAs: true,
                saveDialogExpected: true,
                event: e,
              });
              resolve({ gmEvent: e, onloadFired: true });
            },
            onerror: (e) => {
              const errMsg = e?.error || e?.details || e?.message || String(e);
              clDlLog('gm-download-onerror', { event: e, saveAs: true, errMsg });
              reject(new Error(typeof errMsg === 'string' ? errMsg : 'GM_download failed'));
            },
          });
        }), 30000, 'GM_download');
        clDlLog('VERDICT', {
          scriptPath: 'GM_download',
          onloadFired: true,
          saveDialogExpected: true,
          fileSavedOnDisk: 'unknown-if-no-dialog-appeared-user-cancelled-or-blocked',
          gmEvent: gmResult?.gmEvent,
        });
        clDlLog('download-gm-done');
        return { method: 'GM_download', saveDialogExpected: true, onloadFired: true, fileSavedOnDisk: 'unknown' };
      } catch (e) {
        clDlLog('download-gm-failed', { message: e?.message || String(e) });
      } finally {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      }
    }
    try {
      return downloadBlobViaSandboxAnchor(blob, filename);
    } catch (e) {
      clDlLog('download-anchor-failed', { message: e?.message || String(e) });
    }
    try {
      clDlLog('download-via-page-context');
      return await downloadBlobInPageContext(blob, filename);
    } catch (e) {
      clDlLog('download-page-context-failed', { message: e?.message || String(e) });
    }
    throw new Error('All download paths failed (GM, sandbox anchor, page-context)');
  }

  function buildCoverLetterFilename() {
    const { first, last } = getCandidateNameParts();
    const firstPart = sanitizeCoverLetterFilenamePart(first) || 'Candidate';
    const lastPart = sanitizeCoverLetterFilenamePart(last) || 'Name';
    const companyPart = sanitizeCoverLetterFilenamePart(getCompanyName()) || 'Company';
    return `Cover_letter_${firstPart}_${lastPart}_${companyPart}.docx`;
  }

  async function downloadCoverLetter(text) {
    clDlLog('download-start', { chars: String(text || '').length });
    const filename = buildCoverLetterFilename();
    clDlLog('filename-built', { filename });
    const blob = buildDocxBlob(text);
    const result = await triggerBlobDownload(blob, filename);
    clDlLog('download-finished', result);
    return result;
  }

  function callClaudeCoverLetter(apiKey) {
    return new Promise((resolve, reject) => {
      const knowledge = buildFullKnowledge();
      const jobDescription = getJobDescription();
      const resumeBlock = buildResumeContextBlock();
      const aiInstructionsBlock = buildAiInstructionsBlock();
      const jobTitle = getJobTitle();
      const company = getCompanyName();
      clDlLog('generate-start', {
        jobTitle: jobTitle || 'Unknown',
        company: company || 'Unknown',
        jobDescChars: jobDescription.length,
        knowledgeChars: knowledge.length,
        resumeChars: (getResumeMeta().text || '').length,
      });
      const jobBlock = jobDescription
        ? `\nJob description:\n${jobDescription}\n`
        : '';
      const prompt = `Write a complete cover letter for this job application.

Job title: ${jobTitle || 'Unknown'}
Company: ${company || 'Unknown'}
${jobBlock}
Candidate knowledge notes:
${knowledge}
${resumeBlock}${aiInstructionsBlock}
Rules:
- Plain text only — no markdown, no bullet lists unless natural in prose
- First person ("I", "my", "me") throughout
- Professional tone, about 250–400 words (3–4 short paragraphs)
- Open with why this role and company — reference specifics from the job description when available
- Middle paragraphs: relevant experience and skills drawn ONLY from the knowledge notes and resume — never invent employers, titles, degrees, or skills
- Close with enthusiasm and a brief call to action
- Sign off with "Sincerely," then the candidate's name on the next line if clearly available in the knowledge notes; otherwise end with "Sincerely," alone
- No placeholders like [Company Name] or [Your Name]
- Return ONLY the cover letter text — no preamble or explanation`;

      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        data: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        }),
        onload(res) {
          try {
            const body = JSON.parse(res.responseText);
            if (body.error) {
              reject(new Error('Claude API error: ' + (body.error.message || JSON.stringify(body.error))));
              return;
            }
            let text = body.content[0].text.trim();
            if (text.startsWith('```')) {
              text = text.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
            }
            resolve(text);
          } catch (e) {
            reject(new Error('Cover letter parse failed: ' + res.responseText.slice(0, 200)));
          }
        },
        onerror(err) {
          reject(new Error('Request failed: ' + JSON.stringify(err)));
        },
      });
    });
  }

  const COVER_LETTER_CACHE_KEY = 'jaf_cover_letter_cache';

  function getCoverLetterJobKey() {
    try {
      const u = new URL(location.href);
      u.search = '';
      u.hash = '';
      return `${u.hostname}${u.pathname}`.replace(/\/$/, '').toLowerCase();
    } catch {
      return `${location.hostname}${location.pathname}`.replace(/\/$/, '').toLowerCase();
    }
  }

  function getCoverLetterCache() {
    try {
      const raw = GM_getValue(COVER_LETTER_CACHE_KEY, '{}');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function getCachedCoverLetter(jobKey) {
    return String(getCoverLetterCache()[jobKey] || '').trim();
  }

  async function saveCachedCoverLetter(jobKey, text) {
    const trimmed = String(text || '').trim();
    if (!jobKey || !trimmed) return;
    const cache = getCoverLetterCache();
    cache[jobKey] = trimmed;
    await gmSet(COVER_LETTER_CACHE_KEY, JSON.stringify(cache));
  }

  function openCoverLetterOverlay(letterText, jobKey) {
    document.getElementById('jaf-cover-letter-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'jaf-cover-letter-overlay';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0',
      background: 'rgba(0,0,0,0.6)',
      zIndex: '2147483647',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Segoe UI, system-ui, sans-serif',
    });

    const guardFocus = e => overlayFocusGuard(overlay, e);
    ['focusin', 'focusout', 'focus', 'blur'].forEach(t =>
      window.addEventListener(t, guardFocus, true));
    overlay.addEventListener('keydown', e => e.stopPropagation());

    const textarea = document.createElement('textarea');

    const closeOverlay = () => {
      if (jobKey) saveCachedCoverLetter(jobKey, textarea.value);
      ['focusin', 'focusout', 'focus', 'blur'].forEach(t =>
        window.removeEventListener(t, guardFocus, true));
      overlay.remove();
    };

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background: '#fffbeb', border: '2px solid #f59e0b',
      borderRadius: '12px', padding: '24px 28px',
      width: '640px', maxWidth: '92vw', maxHeight: '85vh',
      display: 'flex', flexDirection: 'column', gap: '12px',
      boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
    });

    const titleRow = document.createElement('div');
    Object.assign(titleRow.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    });

    const titleEl = document.createElement('div');
    titleEl.textContent = 'Cover Letter';
    Object.assign(titleEl.style, {
      fontSize: '16px', fontWeight: '700', color: '#9a3412',
    });

    const xBtn = document.createElement('button');
    xBtn.textContent = '✕';
    xBtn.title = 'Close';
    Object.assign(xBtn.style, {
      width: '30px', height: '30px', border: '1px solid #d97706', borderRadius: '8px',
      background: '#fffdf7', color: '#9a3412', fontSize: '16px', fontWeight: '700', cursor: 'pointer',
    });
    xBtn.addEventListener('click', () => closeOverlay());

    titleRow.appendChild(titleEl);
    titleRow.appendChild(xBtn);

    const hint = document.createElement('div');
    hint.textContent = 'Edit if needed, then download to save to your computer.';
    Object.assign(hint.style, { fontSize: '12px', color: '#78716c', lineHeight: '1.5' });

    textarea.value = letterText;
    Object.assign(textarea.style, {
      flex: '1', minHeight: '320px', resize: 'vertical',
      border: '1.5px solid #d97706', borderRadius: '8px',
      padding: '12px 14px', fontSize: '13px', lineHeight: '1.65',
      fontFamily: 'Segoe UI, system-ui, sans-serif',
      background: '#fff', color: '#1c1917', outline: 'none',
    });

    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, { display: 'flex', gap: '10px', justifyContent: 'flex-end' });

    const downloadBtn = document.createElement('button');
    downloadBtn.textContent = 'Download .docx';
    Object.assign(downloadBtn.style, {
      padding: '9px 20px', borderRadius: '8px', border: 'none',
      background: '#2563eb', color: '#fff', fontSize: '13px',
      fontWeight: '700', cursor: 'pointer',
    });
    downloadBtn.addEventListener('mousedown', e => e.stopPropagation());
    downloadBtn.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      if (downloadBtn.disabled) return;
      const prev = downloadBtn.textContent;
      downloadBtn.disabled = true;
      downloadBtn.textContent = 'Saving…';
      clDlLog('button-click');
      try {
        const dlResult = await downloadCoverLetter(textarea.value);
        clDlLog('button-success', dlResult);
        if (dlResult?.saveDialogExpected) {
          showToast('Save dialog triggered — pick a folder. Confirm file on disk (see console SAVE-WINDOW logs).');
        } else {
          showToast('Download triggered (no Save dialog) — check Downloads folder or browser download bar.');
        }
      } catch (err) {
        clDlLog('button-error', { message: err?.message || String(err), stack: err?.stack });
        console.error('[cover-letter] docx download failed', err);
        showToast(`DOCX export failed: ${err?.message || err}`);
      } finally {
        clDlLog('button-finally-reset');
        downloadBtn.disabled = false;
        downloadBtn.textContent = prev;
      }
    });

    btnRow.appendChild(downloadBtn);
    panel.appendChild(titleRow);
    panel.appendChild(hint);
    panel.appendChild(textarea);
    panel.appendChild(btnRow);
    overlay.appendChild(panel);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay(); });
    document.body.appendChild(overlay);
    textarea.focus();
  }

  async function handleCoverLetterClick() {
    const btn = document.getElementById('jaf-cover-letter-btn');
    if (!btn || btn.disabled) return;
    const prev = btn.textContent;
    const jobKey = getCoverLetterJobKey();
    const cached = getCachedCoverLetter(jobKey);

    if (cached) {
      openCoverLetterOverlay(cached, jobKey);
      showToast('Cover letter loaded (cached for this job)');
      return;
    }

    btn.textContent = 'Generating…';
    btn.disabled = true;
    showSpinner();
    try {
      const letter = await callClaudeCoverLetter(getApiKey());
      if (!letter.trim()) throw new Error('Empty cover letter returned');
      await saveCachedCoverLetter(jobKey, letter);
      openCoverLetterOverlay(letter, jobKey);
      showToast('Cover letter ready — edit and download');
    } catch (e) {
      console.error('[cover-letter]', e);
      showToast('Cover letter failed — see console');
    } finally {
      hideSpinner();
      btn.textContent = prev;
      btn.disabled = false;
    }
  }

  // Look up a question in the combined knowledge (base + learned).
  // Returns the stored answer string, or null if not found.
  function findInUserKnowledge(question) {
    const qNorm = normalizeKey(question);
    let exact = null;
    let fuzzy = null;
    // Iterate all lines and keep the LAST match — so a corrected/newer entry
    // wins over any stale duplicate left earlier in the knowledge text.
    for (const line of buildFullKnowledge().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx < 1) continue;
      const key = normalizeKey(trimmed.slice(0, colonIdx));
      if (!key) continue;
      // Strip a stray leading colon, left by legacy "label:: value" entries.
      const value = trimmed.slice(colonIdx + 1).replace(/^:+\s*/, '').trim();
      if (!value) continue;
      if (key === qNorm) {
        exact = value;
      } else if (qNorm.startsWith(key + ' ') || key.startsWith(qNorm + ' ')) {
        // Whole-word prefix match so a form label like "Email address" still
        // resolves to a KB entry keyed "Email" (and vice versa). Exact wins.
        fuzzy = value;
      }
    }
    return exact != null ? exact : fuzzy;
  }

  // Match a free-text answer to an option label without false positives.
  // Naive substring matching is wrong here: "female" contains "male", so an
  // answer of "Male" would wrongly match the "Female" option. Require an exact
  // match or a whole-word boundary match instead.
  function optionMatchesAnswer(label, answer) {
    const l = String(label).toLowerCase().trim();
    const a = String(answer).toLowerCase().trim();
    if (!l || !a) return false;
    if (l === a) return true;
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wholeWord = (haystack, needle) => new RegExp(`\\b${esc(needle)}\\b`).test(haystack);
    // Negation guard: answer "White (Not Hispanic or Latino)" must not match option "Hispanic or Latino".
    const negates = (x, y) => new RegExp(`\\b(not|non|no)\\b[\\s-]*${esc(y)}\\b`).test(x);
    if (negates(a, l) || negates(l, a)) return false;
    return wholeWord(l, a) || wholeWord(a, l);
  }

  function findBestOptionMatch(answer, options) {
    const matches = options.filter(o => optionMatchesAnswer(o.label, answer));
    if (!matches.length) return null;
    // Prefer the most specific (longest) label when multiple match.
    return matches.sort((a, b) => b.label.length - a.label.length)[0];
  }

  // ─── API key ──────────────────────────────────────────────────────────────
  function getApiKey() {
    const key = String(GM_getValue('anthropic_api_key', '')).trim();
    if (!key) {
      throw new Error('Anthropic API key missing — set anthropic_api_key in Tampermonkey storage');
    }
    return key;
  }

  // ─── Direct field map (no LLM call needed) ────────────────────────────────
  const DIRECT_MAP = [
    [/\bfirst[\s_-]?name\b/i,                                    () => PROFILE.first_name],
    [/\blast[\s_-]?name\b/i,                                     () => PROFILE.last_name],
    [/\bfull[\s_-]?name\b|\byour\s+name\b|\b^name\b/i,          () => `${PROFILE.first_name} ${PROFILE.last_name}`],
    [/\bemail\b/i,                                               () => PROFILE.email],
    [/\bphone\s+country\s+code\b|\bcountry\s+code\b|\bdialing\s+code\b|\bcalling\s+code\b/i, () => 'United States (+1)'],
    [/\bphone\b|\bmobile\b|\btelephone\b/i,                      () => PROFILE.phone],
    [/\blocation\b|\bcity\b|\bwhere.*based\b/i,                  () => PROFILE.location],
    [/\blinkedin\b/i,                                            () => PROFILE.linkedin],
    [/\bgithub\b/i,                                              () => PROFILE.github],
    [/\bportfolio\b|\bwebsite\b|\bpersonal\s+url\b|\bkaggle\b/i, () => PROFILE.portfolio],
    [/\btoday'?s?\s+date\b|\bcurrent\s+date\b/i,                 () => new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })],
  ];

  // ─── Label resolution ─────────────────────────────────────────────────────
  // LinkedIn renders label text in two spans: aria-hidden="true" + visually-hidden.
  // Using innerText reads both and doubles the text. Prefer the aria-hidden span.
  function getElementText(el) {
    const ariaHiddenSpan = el.querySelector('[aria-hidden="true"]');
    if (ariaHiddenSpan) return ariaHiddenSpan.textContent.trim();
    return el.innerText.trim();
  }

  // Strip **markdown** bold syntax and truncate long legal-text labels to first meaningful phrase
  function cleanLabel(text) {
    const stripped = text.replace(/\*\*/g, '').trim();
    // If label is very long (legal boilerplate), keep only first 120 chars up to a word boundary
    if (stripped.length > 120) return stripped.slice(0, 120).replace(/\s\S*$/, '').trim();
    return stripped;
  }

  function getLabelFor(el) {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return cleanLabel(ariaLabel);

    if (el.id) {
      const lbl = document.querySelector(`label[for="${el.id}"]`);
      if (lbl) {
        const text = getElementText(lbl);
        if (text) return cleanLabel(text);
      }
    }

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const lbl = document.getElementById(labelledBy);
      if (lbl) {
        const text = getElementText(lbl);
        if (text) return cleanLabel(text);
      }
    }

    const ancestorLabel = el.closest('label');
    if (ancestorLabel) {
      const text = getElementText(ancestorLabel);
      if (text) return cleanLabel(text);
    }

    return el.getAttribute('placeholder') || el.getAttribute('name') || '';
  }

  // ─── Collect visible, enabled, empty fields ───────────────────────────────
  function collectEmptyFields() {
    const selector = (
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"])' +
      ':not([type="reset"]):not([type="image"]):not([type="file"])' +
      ':not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly]),' +
      'textarea:not([disabled]):not([readonly]),' +
      'select:not([disabled])'
    );

    const results = [];
    for (const el of document.querySelectorAll(selector)) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      // For <select>, LinkedIn uses value="Select an option" as placeholder (non-empty string)
      // so we must detect placeholder options explicitly rather than checking el.value.
      // NOTE: do NOT treat "value === display text" as a placeholder — a real choice
      // (e.g. an email option where value and label are both "name@x.com") has them
      // equal too, and that false positive made already-filled selects get re-asked.
      if (el.tagName.toLowerCase() === 'select') {
        const selectedOpt = el.options[el.selectedIndex];
        const selectedText = (selectedOpt?.text || '').trim().toLowerCase();
        const isPlaceholder = !el.value ||
          !!selectedOpt?.disabled ||
          selectedText.startsWith('select') ||
          selectedText.startsWith('choose') ||
          selectedText.startsWith('please');
        if (!isPlaceholder) continue;
      } else {
        if ((el.value || '').trim()) continue;
      }

      const label = getLabelFor(el);
      if (!label) continue;

      results.push({ el, label });
    }
    return results;
  }

  // ─── Radio button group label (the question text above the options) ────────
  function getRadioGroupQuestion(el) {
    // Walk up to find a fieldset legend or a preceding question element
    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      if (legend) {
        const text = getElementText(legend);
        if (text) return text;
      }
    }
    // Try aria-labelledby on the group container
    const group = el.closest('[role="group"]');
    if (group) {
      const labelledBy = group.getAttribute('aria-labelledby');
      if (labelledBy) {
        const lbl = document.getElementById(labelledBy);
        if (lbl) {
          const text = getElementText(lbl);
          if (text) return text;
        }
      }
      const ariaLabel = group.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    }
    // Fallback: look for a preceding sibling or parent label text
    const parent = el.closest('div, li, section');
    if (parent) {
      const text = parent.innerText.trim().split('\n')[0];
      if (text && text.length < 300) return text;
    }
    return '';
  }

  // LinkedIn-only UI — never auto-fill (not application questions).
  function isSkipFillCheckbox(el) {
    if (!el || el.type !== 'checkbox') return false;
    if (el.name === 'jobDetailsEasyApplyTopChoiceCheckbox') return true;
    if (el.closest('#job-details-easy-apply-top-choice, .job-details-easy-apply-top-choice')) return true;
    const label = (getLabelFor(el) || '').toLowerCase();
    if (/top choice|mark job as/i.test(label)) return true;
    return false;
  }

  // ─── Fill unanswered checkbox groups ─────────────────────────────────────
  async function fillCheckboxGroups(apiKey) {
    const allCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"]:not([disabled])'));
    const visible = allCheckboxes.filter(c => {
      if (isSkipFillCheckbox(c)) return false;
      const rect = c.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const style = getComputedStyle(c);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });

    // Group by nearest shared parent question
    const groups = new Map();
    for (const c of visible) {
      const question = getRadioGroupQuestion(c);
      const key = question || c.name || 'ungrouped';
      if (!groups.has(key)) groups.set(key, { question, options: [], anyChecked: false });
      const g = groups.get(key);
      if (c.checked) g.anyChecked = true;
      g.options.push({ el: c, label: getLabelFor(c) || c.value || '' });
    }

    // Auto-check single-option consent/agreement checkboxes (no Claude call needed)
    const CONSENT_RE = /\b(confirm|agree|certify|acknowledge|understand|accept)\b/i;
    for (const g of groups.values()) {
      if (g.anyChecked || g.options.length !== 1) continue;
      const optLabel = g.options[0].label;
      if (CONSENT_RE.test(optLabel) || CONSENT_RE.test(g.question || '')) {
        const opt = g.options[0];
        if (!opt.el.checked) {
          opt.el.click();
          opt.el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        g.anyChecked = true;
      }
    }

    const unanswered = [...groups.values()].filter(g => !g.anyChecked && g.question && g.options.length > 0);
    if (unanswered.length === 0) return;

    // Ask Claude which options to check for each group
    // Format question as "Q + available options" so Claude knows the choices
    const labelMap = {};
    const claudeLabels = unanswered.map(g => {
      const optionsList = g.options.map(o => o.label).join(' | ');
      const key = `${g.question} [Options: ${optionsList}]`;
      labelMap[key] = g;
      return key;
    });

    let answers = {};
    try {
      answers = await callClaude(apiKey, claudeLabels);
    } catch (e) {
      console.error('[job-fill] checkbox Claude call failed', e);
      return;
    }

    for (const claudeLabel of claudeLabels) {
      const group = labelMap[claudeLabel];
      let answer = answers[claudeLabel];

      if (!answer || !String(answer).trim()) {
        const knownAnswer = findInUserKnowledge(group.question);
        if (knownAnswer) {
          answer = knownAnswer;
        } else {
          const userAnswer = await askUserModal({
            question: group.question,
            type: 'checkbox',
            options: group.options.map(o => o.label),
          });
          if (!userAnswer) continue;
          answer = userAnswer;
          appendToUserKnowledge(group.question, answer);
          showToast(`Saved to Knowledge Base:\n"${group.question}"`);
        }
      }

      // Check every option whose label matches any part of the answer.
      // Answers may list several choices, e.g. "Asian, White" — split on commas.
      const answerParts = String(answer).split(',').map(s => s.trim()).filter(Boolean);
      let anyChecked = false;
      for (const opt of group.options) {
        if (answerParts.some(part => optionMatchesAnswer(opt.label, part))) {
          if (!opt.el.checked) {
            opt.el.click();
            opt.el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          anyChecked = true;
        }
      }

      // No option matched — show modal so user can pick
      if (!anyChecked) {
        const userAnswer = await askUserModal({
          question: group.question,
          type: 'checkbox',
          options: group.options.map(o => o.label),
        });
        if (userAnswer) {
          const userParts = userAnswer.split(',').map(s => s.trim()).filter(Boolean);
          for (const opt of group.options) {
            if (userParts.some(part => optionMatchesAnswer(opt.label, part))) {
              if (!opt.el.checked) {
                opt.el.click();
                opt.el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
          }
          appendToUserKnowledge(group.question, userAnswer);
          showToast(`Saved to Knowledge Base:\n"${group.question}"`);
        }
      }
    }
  }

  // ─── Fill unanswered radio button groups ──────────────────────────────────
  async function fillRadioGroups(apiKey) {
    // Group all visible, unchecked radio buttons by name
    const allRadios = Array.from(document.querySelectorAll('input[type="radio"]:not([disabled])'));
    const visibleRadios = allRadios.filter(r => {
      const rect = r.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const style = getComputedStyle(r);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });

    // Build groups: name → { question, options: [{el, label}], answered }
    const groups = new Map();
    for (const r of visibleRadios) {
      const name = r.name || r.getAttribute('data-name') || r.id;
      if (!name) continue;
      if (!groups.has(name)) {
        const question = getRadioGroupQuestion(r);
        groups.set(name, { question, options: [], answered: false });
      }
      const g = groups.get(name);
      if (r.checked) g.answered = true;
      const optLabel = getLabelFor(r) || r.value || '';
      g.options.push({ el: r, label: optLabel });
    }

    const unanswered = [...groups.values()].filter(g => !g.answered && g.question && g.options.length > 0);
    if (unanswered.length === 0) return;

    // Build one Claude call for all unanswered radio groups.
    // Include each group's options so Claude picks a valid choice (mirrors checkbox/select).
    const radioKeyOf = g => `${g.question} [Options: ${g.options.map(o => o.label).join(' | ')}]`;
    const labels = unanswered.map(radioKeyOf);
    let answers = {};
    try {
      answers = await callClaude(apiKey, labels);
    } catch (e) {
      console.error('[job-fill] radio Claude call failed', e);
      return;
    }

    for (const group of unanswered) {
      let answer = answers[radioKeyOf(group)];

      // If Claude couldn't answer, check knowledge base then show modal
      if (!answer || !String(answer).trim()) {
        const knownAnswer = findInUserKnowledge(group.question);
        if (knownAnswer) {
          answer = knownAnswer;
        } else {
          const userAnswer = await askUserModal({
            question: group.question,
            type: 'radio',
            options: group.options.map(o => o.label),
          });
          if (!userAnswer) continue;
          answer = userAnswer;
          appendToUserKnowledge(group.question, answer);
          showToast(`Saved to Knowledge Base:\n"${group.question}"`);
        }
      }

      // Click the option whose label best matches the answer
      const match = findBestOptionMatch(answer, group.options);
      if (match) {
        match.el.click();
        match.el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // Answer didn't match any option — show modal so user can pick
        const userAnswer = await askUserModal({
          question: group.question,
          type: 'radio',
          options: group.options.map(o => o.label),
        });
        if (userAnswer) {
          const match2 = findBestOptionMatch(userAnswer, group.options);
          if (match2) {
            match2.el.click();
            match2.el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          appendToUserKnowledge(group.question, userAnswer);
          showToast(`Saved to Knowledge Base:\n"${group.question}"`);
        }
      }
    }
  }

  // ─── Fill a field (React/Vue compatible) ──────────────────────────────────
  // Returns true if the field was successfully filled, false if the value
  // couldn't be matched (only meaningful for <select> — text/textarea always true).
  async function fillField(el, value) {
    if (!value) return false;
    const tag = el.tagName.toLowerCase();

    if (tag === 'select') {
      const lower = value.toLowerCase();
      for (const opt of el.options) {
        if (opt.text.toLowerCase().includes(lower) || opt.value.toLowerCase().includes(lower)) {
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false; // no matching option — do NOT set a garbage value
    } else if (tag === 'textarea') {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } else {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      // Typeahead/combobox: wait for dropdown suggestions, then click best match
      const isCombobox = el.getAttribute('role') === 'combobox' ||
                         !!el.getAttribute('aria-autocomplete') ||
                         el.getAttribute('aria-haspopup') === 'listbox';
      if (isCombobox) {
        await pickDropdownOption(value);
      }
      return true;
    }
  }

  // Wait up to 600ms for a visible [role="option"] matching the value, then click it
  function pickDropdownOption(value) {
    const firstWord = value.split(',')[0].trim().toLowerCase();
    return new Promise(resolve => {
      const findAndClick = () => {
        const option = Array.from(document.querySelectorAll('[role="option"]')).find(o => {
          const rect = o.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && o.textContent.toLowerCase().includes(firstWord);
        });
        if (option) { option.click(); return true; }
        return false;
      };

      if (findAndClick()) { resolve(); return; }

      const timeout = setTimeout(() => { observer.disconnect(); resolve(); }, 600);
      const observer = new MutationObserver(() => {
        if (findAndClick()) { clearTimeout(timeout); observer.disconnect(); resolve(); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  // ─── Direct map lookup ────────────────────────────────────────────────────
  function directValue(label) {
    for (const [pattern, getter] of DIRECT_MAP) {
      if (pattern.test(label)) {
        const val = getter();
        return val && val.trim() ? val.trim() : null;
      }
    }
    return null;
  }

  // ─── Toast notification ───────────────────────────────────────────────────
  function showToast(message) {
    document.getElementById('jaf-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'jaf-toast';
    toast.textContent = message;
    Object.assign(toast.style, {
      position: 'fixed', bottom: '80px', left: '12px',
      background: '#1c1917', color: '#fef08a',
      fontSize: '24px', fontWeight: '600',
      padding: '8px 12px', borderRadius: '8px',
      zIndex: '2147483647', maxWidth: '260px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      fontFamily: 'Segoe UI, system-ui, sans-serif',
      lineHeight: '1.4',
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  async function handleCopyJobDescriptionClick() {
    const description = getJobDescription();
    if (!description) {
      showToast('No job description found on this page');
      return;
    }
    const title = getJobTitle();
    const company = getCompanyName();
    const header = [title, company].filter(Boolean).join(' — ');
    const text = header ? `${header}\n\n${description}` : description;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      showToast(`Copied ${text.length.toLocaleString()} chars  ✅`);
    } catch {
      showToast('Copy failed');
    }
  }

  // ─── User prompt modal (replaces browser prompt()) ───────────────────────
  // Shows a styled overlay with the appropriate input control (text, select,
  // radio, or checkbox) matching the original field type. Returns a Promise
  // that resolves to the answer string, or null if the user skips.
  function askUserModal({ question, type = 'text', options = [] }) {
    return new Promise(resolve => {
      document.getElementById('jaf-ask-overlay')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'jaf-ask-overlay';
      Object.assign(overlay.style, {
        position: 'fixed', inset: '0',
        background: 'rgba(0,0,0,0.65)',
        zIndex: '2147483648',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'Segoe UI, system-ui, sans-serif',
      });

      // LinkedIn Easy Apply (and similar app modals) install a focus trap that
      // yanks focus back into their own dialog, which blocks typing in our input.
      // This is the SAME guard the Knowledge Base overlay uses: capturing on
      // window fires before their document-level listener, so we swallow focus
      // events targeting our overlay before the trap can react.
      const guardFocus = e => overlayFocusGuard(overlay, e);
      ['focusin', 'focusout', 'focus', 'blur'].forEach(t =>
        window.addEventListener(t, guardFocus, true));
      // Keep host-page key shortcuts from acting on keystrokes meant for us.
      overlay.addEventListener('keydown', e => e.stopPropagation());

      const teardown = () => {
        ['focusin', 'focusout', 'focus', 'blur'].forEach(t =>
          window.removeEventListener(t, guardFocus, true));
        overlay.remove();
      };

      const panel = document.createElement('div');
      Object.assign(panel.style, {
        position: 'relative',
        background: '#fffbeb', border: '2px solid #f59e0b',
        borderRadius: '14px', padding: '24px 28px',
        width: '500px', maxWidth: '92vw', maxHeight: '85vh',
        overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: '14px',
        boxShadow: '0 16px 48px rgba(0,0,0,0.35)',
      });

      // Close (✕) button — top-right. Cancels the whole fill for this question.
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.title = 'Cancel';
      Object.assign(closeBtn.style, {
        position: 'absolute', top: '10px', right: '12px',
        width: '30px', height: '30px', padding: '0', lineHeight: '1',
        border: 'none', borderRadius: '50%', background: 'transparent',
        color: '#9a3412', fontSize: '20px', fontWeight: '700', cursor: 'pointer',
      });
      closeBtn.onmouseenter = () => { closeBtn.style.background = '#fde68a'; };
      closeBtn.onmouseleave = () => { closeBtn.style.background = 'transparent'; };
      closeBtn.onclick = () => { teardown(); resolve(null); };

      const title = document.createElement('div');
      title.textContent = type === 'checkbox' ? 'Which options apply?' : 'Unknown question — what should I answer?';
      Object.assign(title.style, {
        fontSize: '15px', fontWeight: '700', color: '#9a3412',
      });

      const qBox = document.createElement('div');
      qBox.textContent = `"${question}"`;
      Object.assign(qBox.style, {
        fontSize: '13px', color: '#1c1917', lineHeight: '1.55',
        background: '#fef3c7', borderRadius: '8px', padding: '10px 14px',
        border: '1px solid #fcd34d',
      });

      // ── Input control ──────────────────────────────────────────────────
      let inputEl;
      let getAnswer;

      // Enable "Save & Fill" only once the user has actually picked or typed
      // something — there's nothing to save before a selection is made.
      function updateOkState() {
        const hasAnswer = !!getAnswer();
        okBtn.disabled = !hasAnswer;
        okBtn.style.background = hasAnswer ? '#2563eb' : '#cbd5e1';
        okBtn.style.color = hasAnswer ? '#fff' : '#94a3b8';
        okBtn.style.cursor = hasAnswer ? 'pointer' : 'not-allowed';
      }

      if (type === 'select' && options.length > 0) {
        // Custom styled list instead of native <select> — avoids dark-theme bleed-through
        inputEl = document.createElement('div');
        Object.assign(inputEl.style, { display: 'flex', flexDirection: 'column', gap: '6px' });
        let selectedValue = null;
        for (const opt of options) {
          const row = document.createElement('div');
          row.textContent = opt;
          Object.assign(row.style, {
            fontSize: '14px', color: '#1c1917', cursor: 'pointer',
            padding: '10px 14px', borderRadius: '8px',
            border: '1.5px solid #e5e7eb', background: '#fff',
            userSelect: 'none',
          });
          row.addEventListener('click', () => {
            inputEl.querySelectorAll('div').forEach(r => {
              r.style.borderColor = '#e5e7eb';
              r.style.background = '#fff';
            });
            row.style.borderColor = '#2563eb';
            row.style.background = '#dbeafe';
            selectedValue = opt;
            updateOkState();
          });
          inputEl.appendChild(row);
        }
        getAnswer = () => selectedValue;

      } else if (type === 'radio' && options.length > 0) {
        inputEl = document.createElement('div');
        Object.assign(inputEl.style, { display: 'flex', flexDirection: 'column', gap: '8px' });
        const groupName = 'jaf-radio-' + Date.now();
        for (const opt of options) {
          const row = document.createElement('label');
          Object.assign(row.style, {
            display: 'flex', alignItems: 'center', gap: '10px',
            fontSize: '14px', color: '#1c1917', cursor: 'pointer',
            padding: '10px 14px', borderRadius: '8px',
            border: '1.5px solid #e5e7eb', background: '#fff',
          });
          const radio = document.createElement('input');
          radio.type = 'radio'; radio.name = groupName; radio.value = opt;
          radio.style.accentColor = '#2563eb';
          row.appendChild(radio);
          row.appendChild(document.createTextNode(opt));
          // Highlight on select
          radio.addEventListener('change', () => {
            inputEl.querySelectorAll('label').forEach(l => {
              l.style.borderColor = '#e5e7eb';
              l.style.background = '#fff';
            });
            row.style.borderColor = '#2563eb';
            row.style.background = '#dbeafe';
            updateOkState();
          });
          inputEl.appendChild(row);
        }
        getAnswer = () => {
          const checked = inputEl.querySelector('input[type="radio"]:checked');
          return checked?.value || null;
        };

      } else if (type === 'checkbox' && options.length > 0) {
        inputEl = document.createElement('div');
        Object.assign(inputEl.style, { display: 'flex', flexDirection: 'column', gap: '8px' });
        for (const opt of options) {
          const row = document.createElement('label');
          Object.assign(row.style, {
            display: 'flex', alignItems: 'center', gap: '10px',
            fontSize: '14px', color: '#1c1917', cursor: 'pointer',
            padding: '10px 14px', borderRadius: '8px',
            border: '1.5px solid #e5e7eb', background: '#fff',
          });
          const cb = document.createElement('input');
          cb.type = 'checkbox'; cb.value = opt;
          cb.style.accentColor = '#2563eb';
          cb.addEventListener('change', () => {
            row.style.borderColor = cb.checked ? '#2563eb' : '#e5e7eb';
            row.style.background = cb.checked ? '#dbeafe' : '#fff';
            updateOkState();
          });
          row.appendChild(cb);
          row.appendChild(document.createTextNode(opt));
          inputEl.appendChild(row);
        }
        getAnswer = () => {
          const checked = Array.from(inputEl.querySelectorAll('input[type="checkbox"]:checked'));
          return checked.length > 0 ? checked.map(c => c.value).join(', ') : null;
        };

      } else {
        inputEl = document.createElement('input');
        inputEl.type = 'text';
        Object.assign(inputEl.style, {
          width: '100%', padding: '10px 12px', borderRadius: '8px',
          border: '1.5px solid #d97706', fontSize: '14px',
          background: '#fff', color: '#1c1917', boxSizing: 'border-box',
        });
        getAnswer = () => inputEl.value.trim() || null;
        inputEl.addEventListener('input', updateOkState);
      }

      const hint = document.createElement('div');
      hint.textContent = 'Answer saved to Knowledge Base — won\'t ask again for this question.';
      Object.assign(hint.style, { fontSize: '11px', color: '#78716c', lineHeight: '1.4' });

      const btnRow = document.createElement('div');
      Object.assign(btnRow.style, { display: 'flex', gap: '10px', justifyContent: 'flex-end' });

      const okBtn = document.createElement('button');
      okBtn.textContent = 'Save & Fill';
      Object.assign(okBtn.style, {
        padding: '9px 24px', borderRadius: '8px', border: 'none',
        background: '#2563eb', color: '#fff', fontSize: '13px',
        fontWeight: '700', cursor: 'pointer',
      });
      okBtn.onclick = () => { teardown(); resolve(getAnswer()); };

      if (type === 'text') {
        inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') okBtn.click(); });
      }

      btnRow.appendChild(okBtn);
      panel.appendChild(closeBtn);
      panel.appendChild(title);
      panel.appendChild(qBox);
      panel.appendChild(inputEl);
      panel.appendChild(hint);
      panel.appendChild(btnRow);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      updateOkState(); // start disabled until the user selects/types
      if (type === 'text') inputEl.focus();
    });
  }

  // ─── Claude API call ──────────────────────────────────────────────────────
  // Claude is asked to key its answers by field NUMBER ("1", "2", …). Models
  // drift — they may return "1", "1.", "1. <label>", or even the bare label.
  // This remaps whatever Claude returned back onto the EXACT label strings the
  // caller passed in, so every caller can safely look up answers[label]
  // regardless of how Claude formatted its JSON keys. (Root cause of the old
  // bug: the lookup used the bare label but Claude echoed the "1. " list number
  // into the key, so every lookup missed and answers were silently discarded.)
  function mapNumberedAnswers(raw, labels) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    const entries = Object.entries(raw);
    labels.forEach((label, i) => {
      const num = String(i + 1);
      const wantLabel = String(label).trim();
      for (const [k, v] of entries) {
        const key = String(k).trim();
        const stripped = key.replace(/^\d+\s*[.):\-]?\s*/, '').trim(); // drop leading "1." / "1)" / "1 -"
        const numOnly = key.replace(/[^\d]/g, '');
        const matches =
          key === num ||                          // "1"
          (numOnly === num && stripped === '') ||  // "1." / "1)" (number only)
          key === wantLabel ||                     // bare label
          stripped === wantLabel;                  // "1. <label>"
        if (matches) {
          if (v != null && String(v).trim() !== '') out[label] = v;
          break;
        }
      }
    });
    return out;
  }

  function callClaude(apiKey, labels) {
    return new Promise((resolve, reject) => {
      const knowledge = buildFullKnowledge();
      const jobDescription = getJobDescription();
      const jobBlock = jobDescription
        ? `\nJob description (the specific role being applied to — use this to tailor open-ended answers):\n${jobDescription}\n`
        : '';
      const resumeBlock = buildResumeContextBlock();
      const aiInstructionsBlock = buildAiInstructionsBlock();
      const prompt = `You are filling out a job application for a candidate, using their knowledge notes below${jobDescription ? ' together with the job description for this specific role' : ''}${resumeBlock ? ' and their resume' : ''}.
Return a JSON object whose keys are the field NUMBERS shown below (as strings, e.g. "1", "2") and whose values are the answer string to fill in.
If you genuinely cannot determine an answer, set the value to null.

Field labels (answer each one by its number):
${labels.map((l, i) => `${i + 1}. ${l}`).join('\n')}

Knowledge notes:
${knowledge}
${jobBlock}${resumeBlock}${aiInstructionsBlock}
Rules:
- Factual answers (skills, years of experience, contact info, eligibility, demographics) must come ONLY from the knowledge notes — never fabricate facts or invent experience the candidate does not have.
- For open-ended questions (why interested in this role/company, why you're a good fit, cover-letter style answers), tailor the response to the job description above and reference specifics from it — but ground every claim about the candidate's background in the knowledge notes.
- Write every answer in the FIRST PERSON, as the candidate speaking ("I", "my", "me"). Never refer to the candidate by name or in the third person — do not write "Sam", "he", "she", or "the candidate". E.g. write "I have used Tableau extensively…" not "Sam has used Tableau…".
- For yes/no questions, answer only "Yes" or "No".
- For numeric fields (years of experience, pay rate), give a single number.
- For demographic self-identification (disability, veteran status, gender, race/ethnicity, sexual orientation), use the candidate's answer from the knowledge notes; if it is not present, return null.
- For conditional follow-up questions that do not apply to the candidate (e.g. "If yes, who referred you?" when the answer above is "No", or any "if applicable" / "if other" field that is not applicable), answer "N/A" rather than null — so the field is completed and the user is not prompted.
- If you cannot answer a field, return null for that number.
- Respond ONLY with a valid JSON object keyed by field number. No markdown, no explanation.`;

      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        data: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
        onload(res) {
          try {
            const body = JSON.parse(res.responseText);
            const text = body.content[0].text.trim();
            const cleaned = text.startsWith('```')
              ? text.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim()
              : text;
            resolve(mapNumberedAnswers(JSON.parse(cleaned), labels));
          } catch (e) {
            reject(new Error('Claude response parse failed: ' + res.responseText.slice(0, 200)));
          }
        },
        onerror(err) {
          reject(new Error('Request failed: ' + JSON.stringify(err)));
        },
      });
    });
  }

  // ─── Spinner overlay (visual "running" indicator only) ────────────────────
  // A large, rotating hourglass shown while a fill is in progress. It is purely
  // cosmetic: pointer-events:none so it never blocks clicks, and a lower z-index
  // than the question modal (2147483648) so the modal covers it when one opens.
  function showSpinner() {
    hideSpinner();
    const overlay = document.createElement('div');
    overlay.id = 'jaf-spinner';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: '2147483640', pointerEvents: 'none',
    });
    const glass = document.createElement('div');
    glass.textContent = '⏳';
    Object.assign(glass.style, {
      fontSize: '150px', lineHeight: '1', userSelect: 'none',
      filter: 'drop-shadow(0 6px 18px rgba(0,0,0,0.55))',
    });
    overlay.appendChild(glass);
    document.body.appendChild(overlay);
    glass.animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
      { duration: 3600, iterations: Infinity, easing: 'ease-in-out' }
    );
  }

  function hideSpinner() {
    document.getElementById('jaf-spinner')?.remove();
  }

  // ─── Main fill logic ──────────────────────────────────────────────────────
  async function runFill() {
    const btn = document.getElementById('jaf-fill-btn');
    const setLabel = (text) => { if (btn) btn.textContent = text; };

    setLabel('Working…');
    showSpinner();
    try {
      const fields = collectEmptyFields();

      // Pass 1: direct profile map (no API call)
      const needsLlm = [];
      for (const field of fields) {
        const val = directValue(field.label);
        if (val) {
          await fillField(field.el, val);
          continue;
        }
        // For <select>, append the available options to the Claude key so Claude
        // can pick the right one (same pattern checkbox groups already use).
        let claudeKey = field.label;
        let selectOptions = [];
        if (field.el.tagName.toLowerCase() === 'select') {
          const firstText = (field.el.options[0]?.text || '').toLowerCase();
          const skip = firstText.startsWith('select') || firstText.startsWith('choose') || firstText.startsWith('please');
          selectOptions = Array.from(field.el.options).slice(skip ? 1 : 0).map(o => o.text.trim()).filter(Boolean);
          if (selectOptions.length > 0) claudeKey = `${field.label} [Options: ${selectOptions.join(' | ')}]`;
        }
        needsLlm.push({ el: field.el, label: field.label, claudeKey, selectOptions });
      }

      // Pass 2: Claude for remaining fields
      if (needsLlm.length > 0) {
        const apiKey = getApiKey();
        const answers = await callClaude(apiKey, needsLlm.map(f => f.claudeKey));

        for (const field of needsLlm) {
          const modalType = field.selectOptions.length > 0 ? 'select' : 'text';

          // Cascade: Claude → knowledge base → modal
          // Each step only runs if the previous one returned false (fill failed or no answer).
          const claudeAnswer = answers[field.claudeKey];
          const claudeFilled = claudeAnswer && String(claudeAnswer).trim()
            ? await fillField(field.el, String(claudeAnswer).trim())
            : false;

          if (!claudeFilled) {
            const knownAnswer = findInUserKnowledge(field.label);
            const knownFilled = knownAnswer ? await fillField(field.el, knownAnswer) : false;

            if (!knownFilled) {
              // Nothing worked — always show modal so no field is ever silently skipped
              const userAnswer = await askUserModal({ question: field.label, type: modalType, options: field.selectOptions });
              if (userAnswer) {
                await fillField(field.el, userAnswer);
                appendToUserKnowledge(field.label, userAnswer);
                showToast(`Saved to Knowledge Base:\n"${field.label}"`);
              }
            }
          }
        }
      }

      // Pass 3: radio button groups + checkbox groups
      const apiKey2 = getApiKey();
      await fillRadioGroups(apiKey2);
      await fillCheckboxGroups(apiKey2);

    } catch (e) {
      console.error('[job-fill]', e);
      setLabel('Error — see console');
      setTimeout(() => setLabel('Fill Empty Fields'), 1500);
    } finally {
      hideSpinner();
      const keepLabel = btn && (
        btn.textContent === 'Error — see console'
      );
      if (btn && !keepLabel) setLabel('Fill Empty Fields');
    }
  }

  // ─── Text storage overlays (Knowledge Base, AI instructions) ───────────────
  function openTextStorageEditor({
    overlayId,
    title,
    hint,
    placeholder,
    getValue,
    onSave,
    savedToast,
  }) {
    document.getElementById(overlayId)?.remove();

    const overlay = document.createElement('div');
    overlay.id = overlayId;
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0',
      background: 'rgba(0,0,0,0.6)',
      zIndex: '2147483647',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Segoe UI, system-ui, sans-serif',
    });

    const guardFocus = e => overlayFocusGuard(overlay, e);
    ['focusin', 'focusout', 'focus', 'blur'].forEach(t =>
      window.addEventListener(t, guardFocus, true));
    overlay.addEventListener('keydown', e => e.stopPropagation());

    const closeOverlay = () => {
      ['focusin', 'focusout', 'focus', 'blur'].forEach(t =>
        window.removeEventListener(t, guardFocus, true));
      overlay.remove();
    };

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      background: '#fffbeb', border: '2px solid #f59e0b',
      borderRadius: '12px', padding: '24px 28px',
      width: '560px', maxWidth: '90vw', maxHeight: '80vh',
      display: 'flex', flexDirection: 'column', gap: '12px',
      boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
    });

    const titleRow = document.createElement('div');
    Object.assign(titleRow.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      cursor: 'grab', userSelect: 'none',
    });

    const titleEl = document.createElement('div');
    titleEl.textContent = title;
    Object.assign(titleEl.style, {
      fontSize: '16px', fontWeight: '700', color: '#9a3412',
      letterSpacing: '0.02em',
    });

    const fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.title = 'Toggle fullscreen';
    fsBtn.textContent = '⛶';
    Object.assign(fsBtn.style, {
      width: '36px', height: '36px', padding: '0',
      border: '1px solid #d97706', borderRadius: '8px',
      background: 'linear-gradient(#fffdf7, #fde9c8)',
      cursor: 'pointer', lineHeight: '1', flexShrink: '0',
      fontSize: '26px', color: '#9a3412',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 3px 0 #b45309, 0 4px 6px rgba(0,0,0,0.25)',
    });
    let isFullscreen = false;
    fsBtn.addEventListener('click', () => {
      isFullscreen = !isFullscreen;
      if (isFullscreen) {
        Object.assign(panel.style, {
          width: '100vw', maxWidth: '100vw', maxHeight: '100vh',
          height: '100vh', borderRadius: '0', border: 'none',
        });
        fsBtn.textContent = '⊡';
      } else {
        Object.assign(panel.style, {
          width: '560px', maxWidth: '90vw', maxHeight: '80vh',
          height: '', borderRadius: '12px', border: '2px solid #f59e0b',
        });
        fsBtn.textContent = '⛶';
      }
    });

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.title = 'Copy to clipboard';
    copyBtn.setAttribute('aria-label', 'Copy to clipboard');
    copyBtn.textContent = '📋';
    Object.assign(copyBtn.style, {
      width: '24px', height: '24px', padding: '0',
      border: '1px solid #d97706', borderRadius: '6px',
      background: 'linear-gradient(#fffdf7, #fde9c8)',
      cursor: 'pointer', lineHeight: '1', flexShrink: '0',
      fontSize: '11px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 2px 0 #b45309, 0 3px 5px rgba(0,0,0,0.2)',
    });
    copyBtn.addEventListener('click', async () => {
      const content = textarea.value;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(content);
        } else {
          const ta = document.createElement('textarea');
          ta.value = content;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        showToast('Copied to clipboard');
      } catch {
        showToast('Copy failed');
      }
    });

    const xBtn = document.createElement('button');
    xBtn.title = 'Close';
    xBtn.textContent = '✕';
    Object.assign(xBtn.style, {
      width: '30px', height: '30px', padding: '0',
      border: '1px solid #d97706', borderRadius: '8px',
      background: 'linear-gradient(#fffdf7, #fde9c8)',
      color: '#9a3412', fontSize: '16px', fontWeight: '700',
      cursor: 'pointer', lineHeight: '1',
      boxShadow: '0 3px 0 #b45309, 0 4px 6px rgba(0,0,0,0.25)',
      transition: 'transform 0.05s ease, box-shadow 0.05s ease',
    });
    const xPressDown = () => {
      xBtn.style.transform = 'translateY(2px)';
      xBtn.style.boxShadow = '0 1px 0 #b45309, 0 2px 3px rgba(0,0,0,0.25)';
    };
    const xPressUp = () => {
      xBtn.style.transform = 'translateY(0)';
      xBtn.style.boxShadow = '0 3px 0 #b45309, 0 4px 6px rgba(0,0,0,0.25)';
    };
    xBtn.addEventListener('mousedown', xPressDown);
    xBtn.addEventListener('mouseup', xPressUp);
    xBtn.addEventListener('mouseleave', xPressUp);
    xBtn.addEventListener('click', () => closeOverlay());

    const btnGroup = document.createElement('div');
    Object.assign(btnGroup.style, { display: 'flex', alignItems: 'center', gap: '10px' });
    btnGroup.appendChild(copyBtn);
    btnGroup.appendChild(fsBtn);
    btnGroup.appendChild(xBtn);

    titleRow.appendChild(titleEl);
    titleRow.appendChild(btnGroup);

    const hintEl = document.createElement('div');
    hintEl.textContent = hint;
    Object.assign(hintEl.style, {
      fontSize: '12px', color: '#78716c', lineHeight: '1.5',
    });

    const textarea = document.createElement('textarea');
    textarea.value = getValue();
    textarea.placeholder = placeholder;
    Object.assign(textarea.style, {
      flex: '1', minHeight: '280px', resize: 'vertical',
      border: '1.5px solid #d97706', borderRadius: '8px',
      padding: '10px 12px', fontSize: '13px', lineHeight: '1.6',
      fontFamily: 'Segoe UI, system-ui, sans-serif',
      background: '#fff', color: '#1c1917', outline: 'none',
    });

    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, { display: 'flex', gap: '10px', justifyContent: 'flex-end' });

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    Object.assign(saveBtn.style, {
      padding: '9px 24px', borderRadius: '8px', border: 'none',
      background: '#2563eb', color: '#fff', fontSize: '13px',
      fontWeight: '700', cursor: 'pointer',
    });
    saveBtn.onclick = () => {
      onSave(textarea.value);
      closeOverlay();
      showToast(savedToast);
    };

    let dragging = false, startX, startY, startLeft, startTop;
    titleRow.addEventListener('mousedown', e => {
      if (e.button !== 0 || btnGroup.contains(e.target)) return;
      e.preventDefault();
      const rect = panel.getBoundingClientRect();
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      overlay.style.alignItems = 'flex-start';
      overlay.style.justifyContent = 'flex-start';
      panel.style.position = 'absolute';
      panel.style.margin = '0';
      panel.style.left = startLeft + 'px';
      panel.style.top = startTop + 'px';
      titleRow.style.cursor = 'grabbing';

      const onMove = e => {
        if (!dragging) return;
        panel.style.left = (startLeft + e.clientX - startX) + 'px';
        panel.style.top  = (startTop  + e.clientY - startY) + 'px';
      };
      const onUp = () => {
        dragging = false;
        titleRow.style.cursor = 'grab';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay(); });

    btnRow.appendChild(saveBtn);
    panel.appendChild(titleRow);
    panel.appendChild(hintEl);
    panel.appendChild(textarea);
    panel.appendChild(btnRow);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    textarea.focus();
  }

  function openKnowledgeBase() {
    openTextStorageEditor({
      overlayId: 'jaf-kb-overlay',
      title: 'Knowledge Base',
      hint: 'Add any Q&A pairs or notes here. Claude reads this on every fill. One entry per line — e.g. "How many years with React? 3"',
      placeholder: 'How many years with SuperSense? 2\nPrefer remote work: Yes\n...',
      getValue: getUserKnowledge,
      onSave: saveUserKnowledge,
      savedToast: 'Knowledge Base saved',
    });
  }

  function openAiInstructions() {
    openTextStorageEditor({
      overlayId: 'jaf-ai-instructions-overlay',
      title: 'Instructions for AI',
      hint: 'Extra guidance for Claude on every fill — tone, length, what to emphasize, what to avoid. These are added to the API prompt alongside your Knowledge Base.',
      placeholder: 'Keep open-ended answers under 3 sentences.\nAlways mention my Python and LLM experience when relevant.\nFor "how did you hear about us" answer LinkedIn.\n...',
      getValue: getAiInstructions,
      onSave: saveAiInstructions,
      savedToast: 'AI instructions saved',
    });
  }

  // ─── Preflight overlay (LinkedIn) ─────────────────────────────────────────
  async function openPreflight() {
    document.getElementById('jaf-preflight-overlay')?.remove();

    const fields = collectEmptyFields().map(f => ({
      label: f.label,
      filled: false,
      source: 'prompt',
      answer: '(resolved on fill)',
    }));

    const panel = document.createElement('div');
    panel.id = 'jaf-preflight-overlay';
    Object.assign(panel.style, {
      position: 'fixed', top: '16px', right: '16px',
      zIndex: '2147483647',
      background: '#fffbeb', border: '2px solid #f59e0b',
      borderRadius: '12px', padding: '22px 28px',
      width: '720px', maxWidth: 'calc(100vw - 32px)', maxHeight: '88vh',
      display: 'flex', flexDirection: 'column', gap: '12px',
      boxShadow: '0 12px 40px rgba(0,0,0,0.28)',
      fontFamily: 'Segoe UI, system-ui, sans-serif',
      cursor: 'grab', userSelect: 'none',
    });

    const titleRow = document.createElement('div');
    Object.assign(titleRow.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    });

    const title = document.createElement('div');
    title.textContent = 'Preflight Review';
    Object.assign(title.style, {
      fontSize: '17px', fontWeight: '700', color: '#9a3412', letterSpacing: '0.02em',
    });

    const xBtn = document.createElement('button');
    xBtn.textContent = '✕';
    Object.assign(xBtn.style, {
      width: '28px', height: '28px', padding: '0',
      border: '2px solid #b45309', borderRadius: '8px',
      background: 'linear-gradient(180deg, #fffbeb 0%, #fde68a 100%)',
      color: '#92400e', fontSize: '14px', fontWeight: '700',
      cursor: 'pointer', lineHeight: '1',
      boxShadow: '0 3px 0 #b45309, 0 4px 8px rgba(0,0,0,0.14)',
    });
    xBtn.addEventListener('click', () => panel.remove());

    titleRow.appendChild(title);
    titleRow.appendChild(xBtn);

    const summary = document.createElement('div');
    summary.textContent = `${fields.length} empty field${fields.length !== 1 ? 's' : ''} detected`;
    Object.assign(summary.style, { fontSize: '12px', color: '#78716c', lineHeight: '1.4' });

    const list = document.createElement('ol');
    Object.assign(list.style, {
      margin: '0', paddingLeft: '0', listStyle: 'none',
      display: 'flex', flexDirection: 'column', gap: '8px',
      overflowY: 'auto', maxHeight: 'calc(88vh - 110px)',
    });

    fields.forEach((field, i) => {
      const item = document.createElement('li');
      Object.assign(item.style, {
        fontSize: '13px', lineHeight: '1.45',
        padding: '10px 12px', borderRadius: '8px',
        background: '#fef3c7', border: '1px solid #fde68a',
        color: '#1c1917',
      });
      item.textContent = `${i + 1}. ${field.label}`;
      list.appendChild(item);
    });

    if (fields.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No empty fields detected on this page.';
      Object.assign(empty.style, { fontSize: '13px', color: '#78716c', padding: '8px 0' });
      list.appendChild(empty);
    }

    panel.appendChild(titleRow);
    panel.appendChild(summary);
    panel.appendChild(list);
    document.body.appendChild(panel);
  }

  // ─── Floating widget ──────────────────────────────────────────────────────
  const JAF_WIDGET_VERSION = '12'; // bump when widget buttons/layout change
  let widgetDismissed = false;

  function dismissWidget(widget) {
    widgetDismissed = true;
    widget.remove();
  }

  // Widget is only relevant when a job posting is open (Easy Apply / Copy JD).
  // Person profiles (/in/…), feed, messaging, etc. must never show it.
  function isLinkedInJobPage() {
    if (!location.hostname.includes('linkedin.com')) return false;
    const path = location.pathname;
    if (path.startsWith('/jobs/view/')) return true;
    if (path.startsWith('/jobs/') && /[?&]currentJobId=/.test(location.search)) return true;
    return false;
  }

  function createCopyPagesIcon(size = 16) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const backPage = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    backPage.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');

    const frontPage = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    frontPage.setAttribute('x', '9');
    frontPage.setAttribute('y', '9');
    frontPage.setAttribute('width', '13');
    frontPage.setAttribute('height', '13');
    frontPage.setAttribute('rx', '2');
    frontPage.setAttribute('ry', '2');

    svg.appendChild(backPage);
    svg.appendChild(frontPage);
    return svg;
  }

  function injectWidget() {
    if (widgetDismissed) return;
    // Remove the widget (and don't create one) when this isn't a job posting.
    if (!isLinkedInJobPage()) {
      document.getElementById('jaf-widget')?.remove();
      return;
    }
    const existing = document.getElementById('jaf-widget');
    if (existing) {
      if (existing.dataset.jafVersion === JAF_WIDGET_VERSION) {
        return;
      }
      existing.remove();
    }

    const widget = document.createElement('div');
    widget.id = 'jaf-widget';
    widget.dataset.jafVersion = JAF_WIDGET_VERSION;
    Object.assign(widget.style, {
      position: 'fixed',
      left: '60px',
      top: 'calc(50% - 145px)',
      zIndex: '2147483647',
      width: '240px',
      padding: '48px 14px 18px',
      background: '#fffbeb',
      border: '2px solid #f59e0b',
      borderRadius: '12px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
      fontFamily: 'Segoe UI, system-ui, sans-serif',
      boxSizing: 'border-box',
      cursor: 'grab',
      userSelect: 'none',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
    });

    // ── Close (top-right) ──
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close widget');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
      position: 'absolute', top: '8px', right: '8px', zIndex: '2',
      width: '28px', height: '28px',
      border: '2px solid #b45309', borderRadius: '8px',
      background: 'linear-gradient(180deg, #fffbeb 0%, #fde68a 100%)',
      color: '#92400e',
      fontSize: '14px', fontWeight: '700', lineHeight: '1',
      padding: '0', cursor: 'pointer', userSelect: 'none',
      boxShadow: '0 3px 0 #b45309, 0 4px 8px rgba(0,0,0,0.14)',
      transition: 'transform 0.08s ease, box-shadow 0.08s ease, background 0.12s ease',
    });
    const closeBtnRest = () => {
      closeBtn.style.transform = '';
      closeBtn.style.boxShadow = '0 3px 0 #b45309, 0 4px 8px rgba(0,0,0,0.14)';
      closeBtn.style.background = 'linear-gradient(180deg, #fffbeb 0%, #fde68a 100%)';
    };
    closeBtn.addEventListener('mouseenter', () => {
      closeBtn.style.background = 'linear-gradient(180deg, #ffffff 0%, #fef3c7 100%)';
    });
    closeBtn.addEventListener('mouseleave', closeBtnRest);
    closeBtn.addEventListener('mousedown', e => {
      e.stopPropagation();
      closeBtn.style.transform = 'translateY(2px)';
      closeBtn.style.boxShadow = '0 1px 0 #b45309, 0 2px 4px rgba(0,0,0,0.12)';
    });
    closeBtn.addEventListener('mouseup', closeBtnRest);
    closeBtn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      dismissWidget(widget);
    });

    const fillBtn = document.createElement('button');
    fillBtn.id = 'jaf-fill-btn';
    fillBtn.textContent = 'Fill Empty Fields';
    Object.assign(fillBtn.style, {
      width: '100%', border: '2px solid #1e40af', borderRadius: '10px',
      background: '#2563eb', color: '#fff',
      fontSize: '16px', fontWeight: '700',
      padding: '42px 8px', cursor: 'pointer', lineHeight: '1.2',
      userSelect: 'none',
    });
    fillBtn.addEventListener('mousedown', e => e.stopPropagation());
    fillBtn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); runFill(); });

    const copyJdBtn = document.createElement('button');
    copyJdBtn.id = 'jaf-copy-jd-btn';
    copyJdBtn.type = 'button';
    Object.assign(copyJdBtn.style, {
      width: '100%', border: '2px solid #059669', borderRadius: '10px',
      marginTop: '8px',
      background: 'transparent',
      color: '#047857',
      fontSize: '16px', fontWeight: '700',
      padding: '42px 8px', cursor: 'pointer', lineHeight: '1.2',
      userSelect: 'none',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: '8px',
      boxShadow: '0 3px 0 #047857, 0 4px 8px rgba(0,0,0,0.14)',
      transition: 'transform 0.08s ease, box-shadow 0.08s ease',
    });
    const copyJdBtnRest = () => {
      copyJdBtn.style.transform = '';
      copyJdBtn.style.boxShadow = '0 3px 0 #047857, 0 4px 8px rgba(0,0,0,0.14)';
    };

    const copyJdIcon = document.createElement('span');
    copyJdIcon.setAttribute('aria-hidden', 'true');
    Object.assign(copyJdIcon.style, {
      display: 'inline-flex', alignItems: 'center', flexShrink: '0', lineHeight: '1',
    });
    copyJdIcon.appendChild(createCopyPagesIcon(16));

    const copyJdLabel = document.createElement('span');
    copyJdLabel.textContent = 'Copy Job Description';

    copyJdBtn.appendChild(copyJdIcon);
    copyJdBtn.appendChild(copyJdLabel);
    copyJdBtn.addEventListener('mouseleave', copyJdBtnRest);
    copyJdBtn.addEventListener('mousedown', e => {
      e.stopPropagation();
      copyJdBtn.style.transform = 'translateY(2px)';
      copyJdBtn.style.boxShadow = '0 1px 0 #047857, 0 2px 4px rgba(0,0,0,0.12)';
    });
    copyJdBtn.addEventListener('mouseup', copyJdBtnRest);
    copyJdBtn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      handleCopyJobDescriptionClick();
    });

    const kbBtn = document.createElement('button');
    kbBtn.id = 'jaf-kb-btn';
    kbBtn.textContent = 'Knowledge Base';
    Object.assign(kbBtn.style, {
      width: '100%', border: '2px solid #d97706', borderRadius: '10px',
      background: 'transparent', color: '#9a3412',
      fontSize: '16px', fontWeight: '700',
      padding: '14px 8px', cursor: 'pointer', lineHeight: '1.2',
      userSelect: 'none',
    });
    kbBtn.addEventListener('mousedown', e => e.stopPropagation());
    kbBtn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openKnowledgeBase(); });

    const aiBtn = document.createElement('button');
    aiBtn.id = 'jaf-ai-instructions-btn';
    aiBtn.textContent = 'Instructions for AI';
    Object.assign(aiBtn.style, {
      width: '100%', border: '2px solid #d97706', borderRadius: '10px',
      background: 'transparent', color: '#9a3412',
      fontSize: '14px', fontWeight: '700',
      padding: '12px 8px', cursor: 'pointer', lineHeight: '1.2',
      userSelect: 'none',
    });
    aiBtn.addEventListener('mousedown', e => e.stopPropagation());
    aiBtn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openAiInstructions(); });

    const startWidgetDrag = e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const rect = widget.getBoundingClientRect();
      const ox = e.clientX, oy = e.clientY;
      const baseLeft = rect.left, baseTop = rect.top;
      widget.style.right = 'auto';
      widget.style.bottom = 'auto';
      widget.style.left = baseLeft + 'px';
      widget.style.top = baseTop + 'px';
      widget.style.cursor = 'grabbing';

      const onMove = ev => {
        widget.style.left = (baseLeft + ev.clientX - ox) + 'px';
        widget.style.top  = (baseTop  + ev.clientY - oy) + 'px';
      };
      const onUp = () => {
        widget.style.cursor = 'grab';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    widget.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      startWidgetDrag(e);
    });

    widget.appendChild(closeBtn);
    widget.appendChild(copyJdBtn);
    widget.appendChild(fillBtn);
    widget.appendChild(kbBtn);
    widget.appendChild(aiBtn);
    document.body.appendChild(widget);
  }

  // ─── External Apply labels (job search list) ─────────────────────────────
  function getJobCardFooter(card) {
    return card.querySelector('.job-card-container__footer-wrapper');
  }

  function isJobCardEasyApply(card) {
    const footer = getJobCardFooter(card);
    if (!footer) return false;
    return Array.from(footer.querySelectorAll('.job-card-container__footer-item')).some(
      li => /\bEasy Apply\b/i.test(li.textContent),
    );
  }

  // After submit LinkedIn replaces "Easy Apply" with "Applied · 3 seconds ago" etc.
  function isJobCardApplied(card) {
    const footer = getJobCardFooter(card);
    if (!footer) return false;
    return /\bApplied\b/i.test(footer.textContent);
  }

  function tagExternalApplyJobs() {
    document.querySelectorAll('.job-card-container[data-job-id]').forEach(card => {
      const footer = getJobCardFooter(card);
      if (!footer) return;

      const easy = isJobCardEasyApply(card);
      const applied = isJobCardApplied(card);
      const wasEasy = card.dataset.jafApplyTagged === 'easy';

      if (easy) {
        card.dataset.jafApplyTagged = 'easy';
        footer.querySelector('.jaf-external-apply-label')?.remove();
        return;
      }

      // Easy Apply cards lose the badge after submit — keep them untagged as external.
      if (wasEasy || applied) {
        if (wasEasy) card.dataset.jafApplyTagged = 'easy';
        else card.dataset.jafApplyTagged = 'applied';
        footer.querySelector('.jaf-external-apply-label')?.remove();
        return;
      }

      if (footer.querySelector('.jaf-external-apply-label')) {
        card.dataset.jafApplyTagged = 'external';
        return;
      }

      const li = document.createElement('li');
      li.className = 'job-card-container__footer-item inline-flex align-items-center jaf-external-apply-label';
      const span = document.createElement('span');
      span.setAttribute('dir', 'ltr');
      span.textContent = 'External Apply';
      Object.assign(span.style, { color: '#ea580c', fontWeight: '600', fontSize: '14px' });
      li.appendChild(span);
      footer.appendChild(li);
      card.dataset.jafApplyTagged = 'external';
    });
  }

  function initExternalApplyLabels() {
    tagExternalApplyJobs();
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  if (document.body) {
    injectWidget();
    if (location.hostname.includes('linkedin.com')) initExternalApplyLabels();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      injectWidget();
      if (location.hostname.includes('linkedin.com')) initExternalApplyLabels();
    });
  }

  // Re-inject widget + re-tag job cards on LinkedIn SPA navigation
  if (location.hostname.includes('linkedin.com')) {
    let labelDebounce;
    const observer = new MutationObserver(() => {
      // injectWidget() itself adds on job pages and removes on non-job pages.
      if (!widgetDismissed) injectWidget();
      clearTimeout(labelDebounce);
      labelDebounce = setTimeout(tagExternalApplyJobs, 150);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

})();
