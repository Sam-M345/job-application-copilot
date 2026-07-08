// ==UserScript==
// @name         External Job Applications
// @namespace    job-fill-greenhouse
// @version      4.16
// @description  Greenhouse build. Fills Greenhouse application forms (standalone and embedded iframes, e.g. asana.com) using Claude AI + your Knowledge Base + resume. Runs in all frames for the host/worker iframe relay; excludes LinkedIn so it won't clash with the LinkedIn build.
// @match        *://*/*
// @exclude      *://*.linkedin.com/*
// @grant        GM_addElement
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.anthropic.com
// @connect      cdnjs.cloudflare.com
// @connect      jobs.ashbyhq.com
// @connect      api.ashbyhq.com
// @connect      jobs.gem.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
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

    // ─── Resume (stored in GM — file for upload + extracted text for Claude) ───
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
      if (typeof pdfjsLib === 'undefined') {
        throw new Error('pdfjsLib is unavailable — PDF resume text extraction requires @require pdf.js');
      }
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

    function isCoverLetterFileInput(el) {
      if (!el || el.type !== 'file') return false;
      const labelledBy = el.getAttribute('aria-labelledby') || '';
      const groupLabelledBy = el.closest('[role="group"]')?.getAttribute('aria-labelledby') || '';
      const label = (getFileUploadLabel(el) || getLabelFor(el) || '').toLowerCase();
      const id = (el.id || '').toLowerCase();
      const name = (el.name || '').toLowerCase();
      const combined = `${label} ${id} ${name} ${labelledBy} ${groupLabelledBy}`;
      return /\bcover[\s_-]*letter\b/.test(combined);
    }

    // Greenhouse and similar ATS file widgets label via aria-labelledby / upload-label divs.
    function getFileUploadLabel(el) {
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const lbl = document.getElementById(labelledBy);
        if (lbl) {
          const text = getElementText(lbl);
          if (text) return cleanLabel(text);
        }
      }
      const group = el.closest('[role="group"][aria-labelledby]');
      if (group) {
        const gid = group.getAttribute('aria-labelledby');
        if (gid) {
          const lbl = document.getElementById(gid);
          if (lbl) {
            const text = getElementText(lbl);
            if (text) return cleanLabel(text);
          }
        }
      }
      const uploadRoot = el.closest('.file-upload, [class*="file-upload"]');
      if (uploadRoot) {
        const uploadLabel = uploadRoot.querySelector('[class*="upload-label"], [id*="upload-label"]');
        if (uploadLabel) {
          const text = getElementText(uploadLabel);
          if (text) return cleanLabel(text);
        }
      }
      return '';
    }

    function getResumeFieldLabel(el) {
      if (el?.type === 'file') {
        const uploadLabel = getFileUploadLabel(el);
        if (uploadLabel) return uploadLabel;
        const ariaLabel = getLabelFor(el);
        if (ariaLabel) return ariaLabel;
      }
      const wrapperLabel = getWrapperSiblingLabel(el);
      if (wrapperLabel) return wrapperLabel;
      let node = el.parentElement;
      for (let depth = 0; depth < 10 && node; depth++) {
        for (const span of node.querySelectorAll('[class*="bodyImportant"], label')) {
          const text = getElementText(span);
          if (text) return text;
        }
        node = node.parentElement;
      }
      return getLabelFor(el) || '';
    }

    function findResumeFileInput() {
      const inputs = [...document.querySelectorAll('input[type="file"]')]
        .filter(el => !isCoverLetterFileInput(el));
      if (!inputs.length) return null;

      const scored = inputs.map(el => {
        const label = getResumeFieldLabel(el).toLowerCase();
        const accept = (el.getAttribute('accept') || '').toLowerCase();
        const id = (el.id || '').toLowerCase();
        const name = (el.name || '').toLowerCase();
        const labelledBy = (el.getAttribute('aria-labelledby') || '').toLowerCase();
        const combined = `${label} ${id} ${name} ${labelledBy} ${accept}`;
        let score = 0;
        if (/resume|curriculum|vitae|\bcv\b/.test(combined)) score += 20;
        if (/resume\s*\/\s*cv/i.test(label)) score += 10;
        if (/\.pdf|\.doc|wordprocessingml|msword/.test(accept)) score += 5;
        if (el.id === 'resume' || name === 'resume') score += 15;
        return { el, score, label };
      }).sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (!best || best.score <= 0) return null;
      console.log('[resume] target field:', best.label, best.el);
      return best.el;
    }

    function resumeAlreadyAttached(input) {
      return !!(input.files && input.files.length > 0);
    }

    async function attachResumeToForm({ silent = false } = {}) {
      const meta = getResumeMeta();
      if (!meta.name || !meta.data) {
        if (!silent) showToast('No resume saved — click Resume to choose a file.');
        return false;
      }

      const input = findResumeFileInput();
      if (!input) {
        if (!silent) showToast('No resume upload field found on this page.');
        return false;
      }
      if (isCoverLetterFileInput(input)) {
        console.warn('[resume] refused cover letter upload field');
        if (!silent) showToast('Resume field not found — cover letter field skipped.');
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
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        if (!silent) showToast(`Resume attached: ${meta.name}`);
        console.log('[resume] attached', meta.name, '→', input);
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
        btn.style.color = '#9a3412';
        status.textContent = onPage
          ? 'Attached on this form'
          : (meta.text ? `Saved · ${meta.text.length} chars for AI` : 'Saved · upload only');
        status.style.color = onPage ? '#15803d' : '#78716c';
        actions.style.display = 'flex';
        btn.title = `${meta.name} — click to replace or attach to this form`;
      } else {
        icon.textContent = '📄';
        icon.style.color = '#9a3412';
        label.textContent = 'Resume';
        btn.style.borderColor = '#d97706';
        btn.style.background = 'transparent';
        btn.style.color = '#9a3412';
        status.textContent = 'No resume saved';
        status.style.color = '#78716c';
        actions.style.display = 'none';
        btn.title = 'Choose your resume (PDF recommended). Attaches to forms and feeds Claude.';
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
            const msg = text
              ? `Resume saved — ${text.length} chars extracted for AI`
              : `Resume saved (${file.name}) — upload only; use PDF for AI text`;
            showToast(msg);
            resolve({ name: file.name, text });
          } catch (e) {
            console.error('[resume] save failed', e);
            showToast(`Resume save failed: ${e?.message || e}`);
            reject(e);
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
  
    // ─── Job description scrape ───────────────────────────────────────────────
    const JOB_DESC_CACHE_KEY = 'jaf_job_description_cache';
    const JOB_DESC_MIN_FULL = 800;

    function isAshbyHostedJobPage() {
      const host = location.hostname.replace(/^www\./, '');
      return host === 'jobs.ashbyhq.com' || host.endsWith('.ashbyhq.com');
    }

    function getAshbyJobCacheKey() {
      if (!isAshbyHostedJobPage()) return '';
      let path = location.pathname.replace(/\/$/, '').replace(/\/application$/i, '');
      const parts = path.split('/').filter(Boolean);
      if (parts.length >= 2) return `ashby:${parts[0]}/${parts[1]}`.toLowerCase();
      return '';
    }

    function isGemHostedJobPage() {
      const host = location.hostname.replace(/^www\./, '');
      if (!host.endsWith('.gem.com')) return false;
      const parts = location.pathname.split('/').filter(Boolean);
      return parts.length >= 2;
    }

    function getGemJobCacheKey() {
      if (!isGemHostedJobPage()) return '';
      const parts = location.pathname.split('/').filter(Boolean);
      return `gem:${parts[0]}/${parts[1]}`.toLowerCase();
    }

    function getGemJobIdsFromUrl() {
      if (!isGemHostedJobPage()) return null;
      const parts = location.pathname.split('/').filter(Boolean);
      return { boardId: parts[0], extId: parts[1] };
    }

    function htmlFragmentToPlainText(html) {
      if (!html) return '';
      const div = document.createElement('div');
      div.innerHTML = html;
      return (div.innerText || div.textContent || '').trim();
    }

    function composeGemJobDescription(posting) {
      if (!posting) return '';
      const parts = [];
      const sections = posting.jobPostSectionHtml || {};
      if (sections.introHtml) parts.push(htmlFragmentToPlainText(sections.introHtml));
      if (posting.descriptionHtml) parts.push(htmlFragmentToPlainText(posting.descriptionHtml));
      if (sections.outroHtml) parts.push(htmlFragmentToPlainText(sections.outroHtml));
      if (posting.compensationHtml) parts.push(htmlFragmentToPlainText(posting.compensationHtml));
      return parts.filter(Boolean).join('\n\n').trim();
    }

    function fetchGemJobPosting(boardId, extId) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST',
          url: 'https://jobs.gem.com/api/public/graphql/batch',
          headers: { 'Content-Type': 'application/json', 'batch': 'true' },
          data: JSON.stringify([{
            operationName: 'ExternalJobPostingQuery',
            variables: { boardId, extId },
            query: `query ExternalJobPostingQuery($boardId: String!, $extId: String!) {
              oatsExternalJobPosting(boardId: $boardId, extId: $extId) {
                title descriptionHtml extId
                jobPostSectionHtml { introHtml outroHtml }
                compensationHtml
              }
            }`,
          }]),
          onload(res) {
            try {
              const body = JSON.parse(res.responseText);
              const posting = body?.[0]?.data?.oatsExternalJobPosting;
              if (!posting) {
                reject(new Error(`Gem job not found (HTTP ${res.status})`));
                return;
              }
              resolve(posting);
            } catch (e) {
              reject(new Error('Gem API response parse failed'));
            }
          },
          onerror: () => reject(new Error('Gem API request failed')),
        });
      });
    }

    async function fetchGemJobDescription() {
      const ids = getGemJobIdsFromUrl();
      if (!ids) return '';
      const key = getGemJobCacheKey();
      if (key) {
        const cached = getCachedJobDescription(key);
        if (cached.length > 100) return cached;
      }
      const posting = await fetchGemJobPosting(ids.boardId, ids.extId);
      const text = composeGemJobDescription(posting);
      if (key && text.length >= 100) {
        await saveJobDescriptionCache(key, text);
      }
      return text;
    }

    function extractGemJobPostingText(doc = document) {
      const content = doc.querySelector('[class*="jobPostingContent"]');
      if (!content) return '';
      const text = (content.innerText || content.textContent || '').trim();
      return text.length > 100 ? text : '';
    }

    function getJobDescriptionCache() {
      const raw = GM_getValue(JOB_DESC_CACHE_KEY, '{}');
      if (!String(raw).trim()) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Job description cache is corrupted — clear jaf_job_description_cache in Tampermonkey storage');
      }
      return parsed;
    }

    function getCachedJobDescription(jobKey) {
      return String(getJobDescriptionCache()[jobKey] || '').trim();
    }

    async function saveJobDescriptionCache(jobKey, text) {
      const trimmed = String(text || '').trim();
      if (!jobKey || trimmed.length < 100) return;
      const cache = getJobDescriptionCache();
      cache[jobKey] = trimmed;
      await gmSet(JOB_DESC_CACHE_KEY, JSON.stringify(cache));
    }

    function extractAshbyOverviewText(doc = document) {
      const overview = doc.querySelector('#overview');
      if (!overview) return '';
      const desc = overview.querySelector('[class*="descriptionText"]') || overview;
      return (desc.innerText || desc.textContent || '').trim();
    }

    function extractStripeJobListingDescription(doc = document) {
      const parts = [];
      const article = doc.querySelector('.ArticleMarkdown');
      if (article) {
        const text = (article.innerText || article.textContent || '').trim();
        if (text.length > 100) parts.push(text);
      }
      for (const section of doc.querySelectorAll('section.Copy.variant--Subsection')) {
        const text = (section.innerText || section.textContent || '').trim();
        if (text.length > 50) parts.push(text);
      }
      const combined = parts.join('\n\n').trim();
      return combined.length > 100 ? combined : '';
    }

    function scrapeJobDescriptionFromDocument(doc = document) {
      const selectors = [
        '.ArticleMarkdown',
        '#overview [class*="descriptionText"]',
        '#overview',
        '#job-description',
        '#job_description',
        '.job-post-content',
        '.job__description',
        '.job-description',
        '[data-qa="job-description"]',
        '#content .content',
        'main .prose',
        '[class*="JobDescription"]',
        '[class*="jobDescription"]',
        '[class*="jobPostingContent"]',
        '.ashby-job-posting-left-pane',
      ];
      for (const sel of selectors) {
        const el = doc.querySelector(sel);
        if (el) {
          const text = (el.innerText || el.textContent || '').trim();
          if (text.length > 100) return text;
        }
      }
      return '';
    }

    function getJobDescriptionSync() {
      const MAX = 20000;
      if (/(^|\.)linkedin\.com$/.test(location.hostname)) {
        const linkedinSelectors = [
          '[data-testid="expandable-text-box"]',
          '[data-sdui-component*="aboutTheJob"]',
          '#job-details',
          '.jobs-description__content',
          '.jobs-box__html-content',
          '.jobs-description-content__text',
          '.show-more-less-html__markup',
        ];
        for (const sel of linkedinSelectors) {
          const el = document.querySelector(sel);
          if (el) {
            const text = (el.innerText || '').trim();
            if (text.length > 100) return text.slice(0, MAX);
          }
        }
        return '';
      }

      if (isAshbyHostedJobPage()) {
        const key = getAshbyJobCacheKey();
        if (key) {
          const cached = getCachedJobDescription(key);
          if (cached.length > 100) return cached.slice(0, MAX);
        }
      }

      if (isGemHostedJobPage()) {
        const key = getGemJobCacheKey();
        if (key) {
          const cached = getCachedJobDescription(key);
          if (cached.length > 100) return cached.slice(0, MAX);
        }
        const gemText = extractGemJobPostingText(document);
        if (gemText.length > 100) return gemText.slice(0, MAX);
      }

      if (/(^|\.)stripe\.com$/.test(location.hostname) && /\/jobs\/listing\b/.test(location.pathname)) {
        const stripeText = extractStripeJobListingDescription(document);
        if (stripeText.length > 100) return stripeText.slice(0, MAX);
      }

      const ashbyText = isAshbyHostedJobPage() ? extractAshbyOverviewText(document) : '';
      const text = ashbyText.length > 100 ? ashbyText : scrapeJobDescriptionFromDocument(document);
      return text.length > 100 ? text.slice(0, MAX) : '';
    }

    async function ensureJobDescription() {
      const MAX = 20000;
      let text = getJobDescriptionSync();
      if (text.length <= 100 && isGemHostedJobPage()) {
        text = await fetchGemJobDescription();
      }
      const ashbyKey = getAshbyJobCacheKey();
      if (ashbyKey && text.length >= JOB_DESC_MIN_FULL) {
        await saveJobDescriptionCache(ashbyKey, text);
      }
      const gemKey = getGemJobCacheKey();
      if (gemKey && text.length >= JOB_DESC_MIN_FULL) {
        await saveJobDescriptionCache(gemKey, text);
      }
      return text.slice(0, MAX);
    }

    function tryCacheAshbyJobDescriptionFromDom() {
      if (!isAshbyHostedJobPage() || /\/application$/i.test(location.pathname)) return;
      const key = getAshbyJobCacheKey();
      if (!key) return;
      const text = extractAshbyOverviewText(document);
      if (text.length < JOB_DESC_MIN_FULL) return;
      const cached = getCachedJobDescription(key);
      if (cached.length >= text.length - 100) return;
      saveJobDescriptionCache(key, text);
    }

    function getJobTitle() {
      if (isGemHostedJobPage()) {
        const fromHeader = document.querySelector('[class*="jobPostingHeader"] h1, [class*="jobPostingContent"] h1')?.innerText?.trim();
        if (fromHeader && fromHeader.length > 1 && fromHeader.length < 200) return fromHeader;
        if (document.title && document.title.length > 1 && document.title.length < 200) return document.title.trim();
      }
      if (/(^|\.)stripe\.com$/.test(location.hostname) && /\/jobs\/listing\b/.test(location.pathname)) {
        for (const el of document.querySelectorAll('.Copy__title')) {
          const text = el.innerText?.trim();
          if (!text || text.length > 200) continue;
          if (/^(in-office expectations|pay and benefits)$/i.test(text)) continue;
          return text;
        }
        const fromTitle = document.title.split('|')[0]?.replace(/Stripe.*/i, '').trim();
        if (fromTitle) return fromTitle;
      }
      const selectors = [
        'h1.app-title',
        'h1[data-qa="job-title"]',
        '.job-title',
        '.job__title',
        '[data-testid="job-title"]',
        '.job-details-jobs-unified-top-card__job-title',
        'h1',
      ];
      for (const sel of selectors) {
        const text = document.querySelector(sel)?.innerText?.trim();
        if (text && text.length > 1 && text.length < 200) return text;
      }
      return document.title.split(/[|\-–—]/)[0]?.trim() || '';
    }

    function getCompanyNameFromUrl() {
      const host = location.hostname.replace(/^www\./, '');
      const pathParts = location.pathname.split('/').filter(Boolean);
      const genericHostPrefixes = new Set(['jobs', 'apply', 'careers', 'ats', 'boards', 'www']);

      if (host.endsWith('.gem.com') && pathParts[0]) return pathParts[0];
      if (host === 'boards.greenhouse.io' && pathParts[0]) return pathParts[0];
      if (host.endsWith('.greenhouse.io') && pathParts[0] && host !== 'boards.greenhouse.io') return pathParts[0];

      const hostFirst = host.split('.')[0];
      if (genericHostPrefixes.has(hostFirst) && pathParts[0]) return pathParts[0];

      return '';
    }

    function getCompanyName() {
      const fromUrl = getCompanyNameFromUrl();
      if (fromUrl) return fromUrl;

      const selectors = [
        '.company-name',
        '[data-qa="company-name"]',
        '.job__company',
        '.header-company-name',
        '[data-testid="job-company-name"]',
        '.job-details-jobs-unified-top-card__company-name',
        'header [class*="logo"]',
        '[class*="CompanyName"]',
        '[class*="company-name"]',
      ];
      for (const sel of selectors) {
        const text = document.querySelector(sel)?.innerText?.trim();
        if (text && text.length > 1 && text.length < 120) return text;
      }
      const host = location.hostname.replace(/^www\./, '');
      return host.split('.')[0] || '';
    }

    function sanitizeCoverLetterFilenamePart(s) {
      return String(s || '').trim().replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
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

    function splitPersonName(fullName) {
      const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return { first: '', last: '' };
      if (parts.length === 1) return { first: parts[0], last: '' };
      return { first: parts[0], last: parts.slice(1).join(' ') };
    }

    function getFullNameFromKnowledge() {
      return (
        findKbExactKey('Full name') ||
        findKbExactKey('Name') ||
        findKbExactKey('Your name') ||
        ''
      ).trim();
    }

    function resolveNameValue(label) {
      const text = String(label || '').trim();
      if (!text) return null;

      if (/\bfirst[\s_-]?name\b/i.test(text)) {
        const exact = findKbExactKey('First name');
        if (exact) return exact;
        const fromProfile = (PROFILE.first_name || '').trim();
        if (fromProfile) return fromProfile;
        const full = getFullNameFromKnowledge();
        if (full) return splitPersonName(full).first || null;
        return null;
      }

      if (/\blast[\s_-]?name\b/i.test(text)) {
        const exact = findKbExactKey('Last name');
        if (exact) return exact;
        const fromProfile = (PROFILE.last_name || '').trim();
        if (fromProfile) return fromProfile;
        const full = getFullNameFromKnowledge();
        if (full) return splitPersonName(full).last || null;
        return null;
      }

      if (/\bfull[\s_-]?name\b|\byour\s+name\b/i.test(text) || normalizeKey(text) === 'name') {
        const first = findKbExactKey('First name');
        const last = findKbExactKey('Last name');
        if (first && last) return `${first} ${last}`.trim();
        const fromProfile = `${PROFILE.first_name} ${PROFILE.last_name}`.trim();
        if (fromProfile) return fromProfile;
        const full = getFullNameFromKnowledge();
        return full || null;
      }

      return null;
    }

    function getCandidateNameParts() {
      let first = (findKbExactKey('First name') || PROFILE.first_name || '').trim();
      let last = (findKbExactKey('Last name') || PROFILE.last_name || '').trim();
      if (!first || !last) {
        const full = getFullNameFromKnowledge();
        if (full) {
          const split = splitPersonName(full);
          if (!first) first = split.first;
          if (!last) last = split.last;
        }
      }
      if (!first || !last) {
        throw new Error('Knowledge Base must include name (First name + Last name, or Name: First Last)');
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

    async function triggerBlobDownload(blob, filename) {
      if (typeof GM_download !== 'function') {
        throw new Error('GM_download is unavailable — Tampermonkey must grant GM_download for cover letter export');
      }
      const blobUrl = URL.createObjectURL(blob);
      try {
        clDlLog('download-via-gm');
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
                note: 'onload means Tampermonkey accepted the download — not proof Windows Save dialog appeared or user saved',
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
      } finally {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      }
    }

    function buildCoverLetterFilename() {
      const { first, last } = getCandidateNameParts();
      const firstPart = sanitizeCoverLetterFilenamePart(first);
      const lastPart = sanitizeCoverLetterFilenamePart(last);
      const companyPart = sanitizeCoverLetterFilenamePart(getCompanyName());
      if (!companyPart) {
        throw new Error('Company name could not be determined for cover letter filename');
      }
      return `Cover_letter_${firstPart}_${lastPart}_${companyPart}.docx`;
    }

    async function downloadCoverLetter(text) {
      clDlLog('download-start');
      const filename = buildCoverLetterFilename();
      clDlLog('filename-built', { filename });
      const blob = buildDocxBlob(text);
      const result = await triggerBlobDownload(blob, filename);
      clDlLog('download-finished', result);
      return result;
    }

    function callClaudeCoverLetter(apiKey) {
      return ensureJobDescription().then(jobDescription => new Promise((resolve, reject) => {
        const knowledge = buildFullKnowledge();
        const resumeBlock = buildResumeContextBlock();
        const aiInstructionsBlock = buildAiInstructionsBlock();
        const jobTitle = getJobTitle();
        const company = getCompanyName();
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
      }));
    }

    const COVER_LETTER_CACHE_KEY = 'jaf_cover_letter_cache';

    function getCoverLetterJobKey() {
      const u = new URL(location.href);
      u.search = '';
      u.hash = '';
      return `${u.hostname}${u.pathname}`.replace(/\/$/, '').toLowerCase();
    }

    function getCoverLetterCache() {
      const raw = GM_getValue(COVER_LETTER_CACHE_KEY, '{}');
      if (!String(raw).trim()) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Cover letter cache is corrupted — clear jaf_cover_letter_cache in Tampermonkey storage');
      }
      return parsed;
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

      const guardFocus = e => {
        if (nodeInOverlay(overlay, e.target) || nodeInOverlay(overlay, e.relatedTarget)) {
          e.stopPropagation();
        }
      };
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
      if (getFrameRole() === 'worker') {
        window.parent.postMessage({ jaf: 'spinner-show' }, '*');
      } else {
        showSpinner();
      }
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
        if (getFrameRole() === 'worker') {
          window.parent.postMessage({ jaf: 'spinner-hide' }, '*');
        } else {
          hideSpinner();
        }
        btn.textContent = prev;
        btn.disabled = false;
      }
    }
  
    // Look up a question in the combined knowledge (base + learned).
    // Returns the stored answer string, or null if not found.
    function findDemographicKnowledge(label) {
      if (!/\b(identify\s+as|gender\s+identity)\b/i.test(label)) return null;
      for (const key of ['I identify as', 'Gender identity', 'Gender']) {
        const val = findKbExactKey(key);
        if (val) return val;
      }
      return null;
    }

    function findInUserKnowledge(question) {
      const nameVal = resolveNameValue(question);
      if (nameVal) return nameVal;

      const qNorm = normalizeKey(question);
      const wholeWord = (haystack, needle) => {
        if (!needle || needle.length < 2) return false;
        const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${esc(needle)}\\b`, 'i').test(haystack);
      };
      let exact = null;
      let fuzzy = null;
      let word = null;
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
        } else if (wholeWord(qNorm, key)) {
          // e.g. KB key "pronouns" matches label "[Optional] Pronouns - how should we..."
          word = value;
        }
      }
      const demographic = findDemographicKnowledge(question);
      if (demographic) return demographic;
      return exact != null ? exact : fuzzy != null ? fuzzy : word;
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
      // Negation guard: one string must not match the other when it is merely the
      // other prefixed by a negation. Without this, answer "Not Hispanic or Latino"
      // wholeword-matches the option "Hispanic or Latino" (and vice-versa), which
      // is what selected BOTH ethnicity options. Checked both directions.
      const negates = (x, y) => new RegExp(`\\b(not|non|no)\\b[\\s-]*${esc(y)}\\b`).test(x);
      if (negates(a, l) || negates(l, a)) return false;
      return wholeWord(l, a) || wholeWord(a, l);
    }

    function getApiKey() {
      const key = String(GM_getValue('anthropic_api_key', '')).trim();
      if (!key) {
        throw new Error('Anthropic API key missing — set anthropic_api_key in Tampermonkey storage');
      }
      return key;
    }
  
    // ─── Direct field map (no LLM call needed) ────────────────────────────────
    const DIRECT_MAP = [
      [/\bfirst[\s_-]?name\b/i,                                    () => resolveNameValue('First name')],
      [/\blast[\s_-]?name\b/i,                                     () => resolveNameValue('Last name')],
      [/\bfull[\s_-]?name\b|\byour\s+name\b|\b^name\b/i,          () => resolveNameValue('Full name')],
      [/\bemail\b/i,                                               () => PROFILE.email],
      [/\bphone\s+country\s+code\b|\bcountry\s+code\b|\bdialing\s+code\b|\bcalling\s+code\b/i, () => 'United States (+1)'],
      [/\bphone\b|\bmobile\b|\btelephone\b/i,                      () => PROFILE.phone],
      [/\bcountry\b/i,                                             () => 'United States'],
      [/\blocation\b|\bcity\b|\bwhere.*based\b/i,                  () => PROFILE.location],
      [/\blinkedin\b/i,                                            () => PROFILE.linkedin],
      [/\bgithub\b/i,                                              () => PROFILE.github],
      [/\bportfolio\b|\bwebsite\b|\bpersonal\s+url\b|\bkaggle\b/i, () => PROFILE.portfolio],
      [/\btoday'?s?\s+date\b|\bcurrent\s+date\b/i,                 () => new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })],
    ];
  
    // ─── Label resolution ─────────────────────────────────────────────────────
    // LinkedIn renders label text in two spans: aria-hidden="true" + visually-hidden.
    // Using innerText reads both and doubles the text, so we prefer the aria-hidden
    // span — BUT only when it carries real label text. Greenhouse uses an
    // aria-hidden span solely for the required "*" marker (e.g. "<question>*"), so a
    // punctuation-only span must be ignored or the whole label collapses to "*".
    function getElementText(el) {
      if (!el) return '';
      const ariaHiddenSpan = el.querySelector?.('[aria-hidden="true"]');
      if (ariaHiddenSpan) {
        const ahText = (ariaHiddenSpan.textContent || '').trim();
        if (ahText.replace(/[^a-z0-9]/gi, '').length >= 2) return ahText;
      }
      const fullText = typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
      return fullText.replace(/\*/g, '').trim();
    }
  
    // Strip **markdown** bold syntax and truncate long legal-text labels to first meaningful phrase
    function cleanLabel(text) {
      const stripped = text.replace(/\*\*/g, '').trim();
      // If label is very long (legal boilerplate), keep only first 120 chars up to a word boundary
      if (stripped.length > 120) return stripped.slice(0, 120).replace(/\s\S*$/, '').trim();
      return stripped;
    }

    const HIDDEN_FIELD_NAMES = new Set(['g-recaptcha-response', 'h-captcha-response']);

    function isHiddenAutomationField(el) {
      const name = (el.getAttribute('name') || '').toLowerCase();
      if (HIDDEN_FIELD_NAMES.has(name)) return true;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;
      const rect = el.getBoundingClientRect();
      return rect.width === 0 && rect.height === 0;
    }

    // Gem ATS (jobs.gem.com) puts the label in a sibling span/div above the field wrapper,
    // not on <label for="...">. Same pattern appears on some other modern ATS forms.
    function getWrapperSiblingLabel(el) {
      const fieldWrap = el.closest('[class*="textField"], [class*="textareaField"]');
      if (fieldWrap) {
        const row = fieldWrap.parentElement;
        if (row) {
          for (const child of row.children) {
            if (child === fieldWrap || child.contains(el)) continue;
            const text = getElementText(child);
            if (text && text.length > 1 && text.length < 300) return cleanLabel(text);
          }
        }
      }

      let node = el.parentElement;
      for (let depth = 0; depth < 6 && node; depth++) {
        for (const child of node.children) {
          if (child.contains(el)) continue;
          const important = child.querySelector?.('[class*="bodyImportant"]');
          const text = important ? getElementText(important) : getElementText(child);
          if (text && text.length > 1 && text.length < 300 && !/^(yes|no)$/i.test(text.trim())) {
            return cleanLabel(text);
          }
        }
        if (node.querySelectorAll('input[type="radio"]').length >= 2) break;
        node = node.parentElement;
      }
      return '';
    }

    function getRadioGroupKey(r) {
      if (r.name) return r.name;
      let node = r.parentElement;
      for (let depth = 0; depth < 8 && node; depth++) {
        const radios = node.querySelectorAll('input[type="radio"]');
        if (radios.length >= 2 && [...radios].includes(r)) {
          const q = getRadioGroupQuestion(r);
          if (q) return q;
          return 'rg-' + [...radios].map(x => x.id).sort().join('|');
        }
        node = node.parentElement;
      }
      return r.id || r.getAttribute('data-name') || 'ungrouped';
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

      const wrapperLabel = getWrapperSiblingLabel(el);
      if (wrapperLabel) return wrapperLabel;
  
      return el.getAttribute('placeholder') || el.getAttribute('name') || '';
    }

    // Some forms (including Greenhouse variants) visually render a checkbox via
    // wrapper/label while the real <input type="checkbox"> is 0x0. Use the
    // rendered label/container rect as a fallback so visible checkbox questions
    // are not skipped by geometry checks.
    function getVisibleRectForChoiceInput(el) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) return rect;
      if (el.id) {
        const lbl = document.querySelector(`label[for="${el.id}"]`);
        if (lbl) {
          const lr = lbl.getBoundingClientRect();
          if (lr.width > 0 || lr.height > 0) return lr;
        }
      }
      const ashbyRow = el.closest('[class*="_option_"]');
      if (ashbyRow) {
        const ar = ashbyRow.getBoundingClientRect();
        if (ar.width > 0 || ar.height > 0) return ar;
      }
      const wrapper = el.closest('.checkbox, .checkbox__wrapper, .field-wrapper, label');
      if (wrapper) {
        const wr = wrapper.getBoundingClientRect();
        if (wr.width > 0 || wr.height > 0) return wr;
      }
      return rect;
    }

    function setInputChecked(input, checked) {
      const view = input.ownerDocument?.defaultView;
      if (!view) throw new Error('setInputChecked: input has no owner document');
      const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'checked')?.set;
      if (!setter) throw new Error('setInputChecked: HTMLInputElement.checked setter unavailable');
      setter.call(input, checked);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function findChoiceOption(field, answer) {
      return field.options.find(o => optionMatchesAnswer(o.label, String(answer))) || null;
    }

    function isAshbyOptionRowSelected(row) {
      if (!row) return false;
      return (row.className || '').split(/\s+/).includes('true');
    }

    function isAshbyEeoRadio(input) {
      if (!input || input.type !== 'radio') return false;
      const row = input.closest('[class*="_option_"]');
      if (!row || !row.querySelector('[class*="_circle_"]')) return false;
      return !!input.closest('fieldset')?.querySelector(
        '.ashby-application-form-question-title, [class*="question-title"]',
      );
    }

    function isChoiceInputSelected(input) {
      if (!input) return false;
      if (isAshbyEeoRadio(input)) {
        return isAshbyOptionRowSelected(input.closest('[class*="_option_"]'));
      }
      return !!input.checked;
    }

    function isAshbyYesNoButtonSelected(btn) {
      if (!btn) return false;
      if (btn.getAttribute('aria-pressed') === 'true') return true;
      if ((btn.className || '').split(/\s+/).includes('true')) return true;
      if (/selected|active|checked/i.test(btn.className)) return true;
      return false;
    }

    function isAshbyYesNoAnswered(container) {
      for (const btn of container.querySelectorAll('button')) {
        const label = btn.textContent.trim().toLowerCase();
        if (label !== 'yes' && label !== 'no') continue;
        if (isAshbyYesNoButtonSelected(btn)) return true;
      }
      return false;
    }

    function getAshbyFieldQuestion(container) {
      const entry = container.closest('[data-field-path], [class*="fieldEntry"]');
      const titleEl = entry?.querySelector(
        'label.ashby-application-form-question-title, label[class*="question-title"]',
      );
      return titleEl ? cleanLabel(getElementText(titleEl)) : '';
    }

    function collectAshbyYesNoFields(seenLabels, { includeFilled = false } = {}) {
      const fields = [];
      for (const container of document.querySelectorAll('[class*="_yesno_"]')) {
        const buttons = [...container.querySelectorAll('button')].filter(btn => {
          const t = btn.textContent.trim().toLowerCase();
          return t === 'yes' || t === 'no';
        });
        if (buttons.length < 2) continue;
        const answered = isAshbyYesNoAnswered(container);
        if (!includeFilled && answered) continue;
        const question = getAshbyFieldQuestion(container);
        if (!question || seenLabels.has(question)) continue;
        const rect = container.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        seenLabels.add(question);
        const entry = container.closest('[data-field-path]');
        const options = buttons.map(btn => ({ el: btn, label: btn.textContent.trim() }));
        const selected = answered
          ? buttons.find(btn => isAshbyYesNoButtonSelected(btn))
          : null;
        fields.push({
          type: 'yesno',
          label: question,
          fieldPath: entry?.getAttribute('data-field-path') || '',
          claudeKey: `${question} [Options: ${options.map(o => o.label).join(' | ')}]`,
          options,
          container,
          filled: answered,
          currentValue: selected?.textContent.trim() || '',
          sortY: rect.top + window.scrollY,
          sortX: rect.left,
        });
      }
      return fields;
    }

    function clickAshbyYesNoButton(btn, fieldPath) {
      if (!btn) return Promise.resolve(false);
      const label = btn.textContent.trim();
      if (fieldPath) {
        return runAshbyYesNoClickInPageContext(fieldPath, label).then(ok => {
          if (ok) return true;
          fireMouseSequence(btn);
          btn.click();
          return isAshbyYesNoButtonSelected(btn);
        });
      }
      fireMouseSequence(btn);
      btn.click();
      return Promise.resolve(isAshbyYesNoButtonSelected(btn));
    }

    // Ashby EEO radios must click in page context (Tampermonkey isolated world only highlights).
    async function clickChoiceInput(input) {
      if (!input) return false;
      if (isAshbyEeoRadio(input) && input.id) {
        return runAshbyChoiceClickInPageContext(input.id);
      }

      const doc = input.ownerDocument;
      const label = input.id ? doc.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
      const optionRow = input.closest('[class*="_option_"]');
      const ashbyVisual = optionRow?.querySelector('[class*="_container_"]');
      const targets = [label, ashbyVisual, optionRow, input].filter(Boolean);
      const seen = new Set();
      for (const target of targets) {
        if (seen.has(target)) continue;
        seen.add(target);
        fireMouseSequence(target);
        target.click();
        if (isChoiceInputSelected(input)) return true;
      }
      if (!input.checked) setInputChecked(input, true);
      return isChoiceInputSelected(input);
    }

    function getAshbyEeoFillOrder(field) {
      if (field.type !== 'radio' || !field.options?.[0]?.el) return null;
      const name = field.options[0].el.getAttribute('name') || '';
      if (name.includes('eeoc_race')) return 1;
      if (name.includes('eeoc_veteran')) return 2;
      if (name.includes('eeoc_gender')) return 3;
      return null;
    }

    function sortFillableFields(fields) {
      return fields.slice().sort((a, b) => {
        const ae = getAshbyEeoFillOrder(a);
        const be = getAshbyEeoFillOrder(b);
        if (ae != null && be != null) return ae - be;
        const vertDiff = (a.sortY || 0) - (b.sortY || 0);
        return Math.abs(vertDiff) > 10 ? vertDiff : (a.sortX || 0) - (b.sortX || 0);
      });
    }

    function syncGemTextareaWrapper(textarea, value) {
      const growWrap = textarea.closest('[class*="growWrap"]');
      if (!growWrap) return;
      growWrap.setAttribute('data-value', value ? value + '\n' : '');
      growWrap.style.height = 'auto';
    }
  
    function getGreenhouseApplicationQuestion(el) {
      const appQuestion = el.closest('li.application-question, .application-question');
      if (!appQuestion) return '';
      const labelEl = appQuestion.querySelector('.application-label');
      if (!labelEl) return '';
      const text = cleanLabel(getElementText(labelEl));
      return text || '';
    }

    function resolveCheckboxGroup(checkbox) {
      const optionLabel = getLabelFor(checkbox) || checkbox.value || '';
      let question = getRadioGroupQuestion(checkbox) || getGreenhouseApplicationQuestion(checkbox);
      const name = checkbox.getAttribute('name') || '';
      const namedPeerCount = name
        ? document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`).length
        : 0;
      const appQuestion = checkbox.closest('li.application-question, .application-question');
      const appPeerCount = appQuestion
        ? appQuestion.querySelectorAll('input[type="checkbox"]').length
        : 0;

      if (namedPeerCount > 1 || appPeerCount > 1) {
        const groupQuestion = question && question !== optionLabel
          ? question
          : (getGreenhouseApplicationQuestion(checkbox) || question || cleanLabel(name));
        if (groupQuestion) return { key: groupQuestion, question: groupQuestion };
      }

      const key = question || optionLabel || name || 'ungrouped';
      return { key, question: question || optionLabel || name || '' };
    }

    // ─── Collect ALL unfilled fields in visual order (preflight-ordered fill list) ──────────
    function collectFillableFields() {
      const textSelector = (
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"])' +
        ':not([type="reset"]):not([type="image"]):not([type="file"])' +
        ':not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly]),' +
        'textarea:not([disabled]):not([readonly]),' +
        'select:not([disabled])'
      );

      const fields = [];
      const seenLabels = new Set();

      for (const el of document.querySelectorAll(textSelector)) {
        if (isHiddenAutomationField(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        // Detect empty/unfilled
        let isEmpty = false;
        if (el.tagName.toLowerCase() === 'select') {
          const selectedOpt = el.options[el.selectedIndex];
          const selectedText = (selectedOpt?.text || '').trim().toLowerCase();
          isEmpty = !el.value || !!selectedOpt?.disabled ||
            selectedText.startsWith('select') || selectedText.startsWith('choose') || selectedText.startsWith('please');
        } else if (el.classList.contains('select__input') || el.getAttribute('role') === 'combobox') {
          const invalid = el.getAttribute('aria-invalid') === 'true' || !!el.closest('.select__control--error');
          if (!invalid) {
            const container = el.closest('.select__value-container');
            isEmpty = !container ||
              (!container.classList.contains('select__value-container--has-value') &&
               !container.querySelector('.select__single-value'));
          } else {
            isEmpty = true;
          }
        } else {
          isEmpty = !(el.value || '').trim();
        }
        if (!isEmpty) continue;

        const label = getLabelFor(el);
        if (!label || seenLabels.has(label)) continue;
        seenLabels.add(label);

        // Build claudeKey — native <select> gets its options list so Claude can pick the right one
        let claudeKey = label;
        let selectOptions = [];
        if (el.tagName.toLowerCase() === 'select') {
          const firstText = (el.options[0]?.text || '').toLowerCase();
          const skipFirst = firstText.startsWith('select') || firstText.startsWith('choose') || firstText.startsWith('please');
          selectOptions = Array.from(el.options).slice(skipFirst ? 1 : 0).map(o => o.text.trim()).filter(Boolean);
          if (selectOptions.length > 0) claudeKey = `${label} [Options: ${selectOptions.join(' | ')}]`;
        }

        fields.push({ type: 'text', el, label, claudeKey, selectOptions, sortY: rect.top + window.scrollY, sortX: rect.left });
      }

      // Radio groups — only unanswered groups
      const radioGroups = new Map();
      for (const r of document.querySelectorAll('input[type="radio"]:not([disabled])')) {
        const rect = getVisibleRectForChoiceInput(r);
        if (rect.width === 0 && rect.height === 0) continue;
        const style = getComputedStyle(r);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const name = getRadioGroupKey(r);
        if (!name) continue;
        if (!radioGroups.has(name)) {
          const question = getRadioGroupQuestion(r);
          radioGroups.set(name, { question, options: [], answered: false, sortY: rect.top + window.scrollY, sortX: rect.left });
        }
        const g = radioGroups.get(name);
        if (r.checked || isAshbyOptionRowSelected(r.closest('[class*="_option_"]'))) g.answered = true;
        g.options.push({ el: r, label: getLabelFor(r) || r.value || '' });
      }
      for (const g of radioGroups.values()) {
        if (g.answered || !g.question || g.options.length === 0 || seenLabels.has(g.question)) continue;
        seenLabels.add(g.question);
        const claudeKey = `${g.question} [Options: ${g.options.map(o => o.label).join(' | ')}]`;
        fields.push({ type: 'radio', label: g.question, claudeKey, options: g.options, sortY: g.sortY, sortX: g.sortX });
      }

      fields.push(...collectAshbyYesNoFields(seenLabels));

      // Checkbox groups — only unchecked groups
      const cbGroups = new Map();
      for (const c of document.querySelectorAll('input[type="checkbox"]:not([disabled])')) {
        if (c.closest('[class*="_yesno_"]')) continue;
        const rect = getVisibleRectForChoiceInput(c);
        if (rect.width === 0 && rect.height === 0) continue;
        const style = getComputedStyle(c);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const { key, question } = resolveCheckboxGroup(c);
        if (!cbGroups.has(key)) cbGroups.set(key, { question, options: [], anyChecked: false, sortY: rect.top + window.scrollY, sortX: rect.left });
        const g = cbGroups.get(key);
        if (c.checked) g.anyChecked = true;
        g.options.push({ el: c, label: getLabelFor(c) || c.value || '' });
      }
      for (const g of cbGroups.values()) {
        if (g.anyChecked || !g.question || g.options.length === 0 || seenLabels.has(g.question)) continue;
        seenLabels.add(g.question);
        const claudeKey = `${g.question} [Options: ${g.options.map(o => o.label).join(' | ')}]`;
        fields.push({ type: 'checkbox', label: g.question, claudeKey, options: g.options, sortY: g.sortY, sortX: g.sortX });
      }

      // Sort by visual position; Ashby EEO groups fill race → veteran → gender
      return sortFillableFields(fields);
    }

    // ─── Current DOM value for preflight display ───────────────────────────────
    function getCurrentFieldValue(el) {
      if (el.tagName.toLowerCase() === 'select') {
        const opt = el.options[el.selectedIndex];
        return opt ? opt.text.trim() : '';
      }
      if (el.classList.contains('select__input') || el.getAttribute('role') === 'combobox') {
        const single = el.closest('.select__value-container')?.querySelector('.select__single-value');
        if (single?.textContent.trim()) return single.textContent.trim();
      }
      return (el.value || '').trim();
    }

    // ─── Collect ALL fields with fill metadata for preflight answer resolution ─
    function collectPreflightFields() {
      const textSelector = (
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"])' +
        ':not([type="reset"]):not([type="image"]):not([type="file"])' +
        ':not([type="checkbox"]):not([type="radio"]):not([disabled]),' +
        'textarea:not([disabled]),' +
        'select:not([disabled])'
      );

      const fields = [];
      const seenLabels = new Set();

      for (const el of document.querySelectorAll(textSelector)) {
        if (isHiddenAutomationField(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        let filled = false;
        if (el.tagName.toLowerCase() === 'select') {
          const selectedOpt = el.options[el.selectedIndex];
          const selectedText = (selectedOpt?.text || '').trim().toLowerCase();
          filled = !!(el.value && !selectedOpt?.disabled &&
            !selectedText.startsWith('select') && !selectedText.startsWith('choose') && !selectedText.startsWith('please'));
        } else if (el.classList.contains('select__input') || el.getAttribute('role') === 'combobox') {
          filled = isReactSelectCommitted(el);
        } else {
          filled = !!(el.value || '').trim();
        }

        const label = getLabelFor(el);
        if (!label || seenLabels.has(label)) continue;
        seenLabels.add(label);

        let claudeKey = label;
        let selectOptions = [];
        if (el.tagName.toLowerCase() === 'select') {
          const firstText = (el.options[0]?.text || '').toLowerCase();
          const skipFirst = firstText.startsWith('select') || firstText.startsWith('choose') || firstText.startsWith('please');
          selectOptions = Array.from(el.options).slice(skipFirst ? 1 : 0).map(o => o.text.trim()).filter(Boolean);
          if (selectOptions.length > 0) claudeKey = `${label} [Options: ${selectOptions.join(' | ')}]`;
        }

        fields.push({
          type: 'text', el, label, filled,
          currentValue: filled ? getCurrentFieldValue(el) : '',
          claudeKey, selectOptions,
          sortY: rect.top + window.scrollY, sortX: rect.left,
        });
      }

      const radioGroups = new Map();
      for (const r of document.querySelectorAll('input[type="radio"]:not([disabled])')) {
        const rect = getVisibleRectForChoiceInput(r);
        if (rect.width === 0 && rect.height === 0) continue;
        const style = getComputedStyle(r);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const name = getRadioGroupKey(r);
        if (!name) continue;
        if (!radioGroups.has(name)) {
          radioGroups.set(name, {
            question: getRadioGroupQuestion(r), options: [],
            answered: false, currentValue: '',
            sortY: rect.top + window.scrollY, sortX: rect.left,
          });
        }
        const g = radioGroups.get(name);
        const rowSelected = r.checked || isAshbyOptionRowSelected(r.closest('[class*="_option_"]'));
        if (rowSelected) {
          g.answered = true;
          g.currentValue = getLabelFor(r) || r.value || '';
        }
        g.options.push({ el: r, label: getLabelFor(r) || r.value || '' });
      }
      for (const g of radioGroups.values()) {
        if (!g.question || g.options.length === 0 || seenLabels.has(g.question)) continue;
        seenLabels.add(g.question);
        const claudeKey = `${g.question} [Options: ${g.options.map(o => o.label).join(' | ')}]`;
        fields.push({
          type: 'radio', label: g.question, filled: g.answered,
          currentValue: g.currentValue, claudeKey, options: g.options,
          sortY: g.sortY, sortX: g.sortX,
        });
      }

      fields.push(...collectAshbyYesNoFields(seenLabels, { includeFilled: true }));

      const cbGroups = new Map();
      for (const c of document.querySelectorAll('input[type="checkbox"]:not([disabled])')) {
        if (c.closest('[class*="_yesno_"]')) continue;
        const rect = getVisibleRectForChoiceInput(c);
        if (rect.width === 0 && rect.height === 0) continue;
        const style = getComputedStyle(c);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const { key, question } = resolveCheckboxGroup(c);
        if (!cbGroups.has(key)) {
          cbGroups.set(key, {
            question, options: [], anyChecked: false, checkedLabels: [],
            sortY: rect.top + window.scrollY, sortX: rect.left,
          });
        }
        const g = cbGroups.get(key);
        const optLabel = getLabelFor(c) || c.value || '';
        g.options.push({ el: c, label: optLabel });
        if (c.checked) {
          g.anyChecked = true;
          if (optLabel) g.checkedLabels.push(optLabel);
        }
      }
      for (const g of cbGroups.values()) {
        if (!g.question || g.options.length === 0 || seenLabels.has(g.question)) continue;
        seenLabels.add(g.question);
        const claudeKey = `${g.question} [Options: ${g.options.map(o => o.label).join(' | ')}]`;
        fields.push({
          type: 'checkbox', label: g.question, filled: g.anyChecked,
          currentValue: g.checkedLabels.join(', '),
          claudeKey, options: g.options,
          sortY: g.sortY, sortX: g.sortX,
        });
      }

      fields.sort((a, b) => {
        const vertDiff = a.sortY - b.sortY;
        return Math.abs(vertDiff) > 10 ? vertDiff : (a.sortX || 0) - (b.sortX || 0);
      });
      return fields;
    }

    const CONSENT_RE = /\b(confirm|agree|certify|acknowledge|understand|accept)\b/i;

    // Single draft shared by Preflight review and Fill — never regenerate if still valid.
    let jafDraft = null;

    function computeFormFingerprint() {
      return collectPreflightFields().map(f => f.label).join('\0');
    }

    function isDraftPlaceholderAnswer(answer) {
      if (!answer || !String(answer).trim()) return true;
      const t = String(answer).trim();
      return t.startsWith('(will ask') ||
        t.startsWith('(Claude error') ||
        t === '(filled)' ||
        t === '(no answer)';
    }

    function draftNeedsPrompt(item) {
      return !item.filled && (
        item.source === 'prompt' ||
        isDraftPlaceholderAnswer(item.answer)
      );
    }

    async function ensureDraft(force = false) {
      const fingerprint = computeFormFingerprint();
      if (!force && jafDraft && jafDraft.fingerprint === fingerprint) {
        console.log('[DRAFT] reusing cached draft', { usedForFill: jafDraft.usedForFill, age: Date.now() - jafDraft.generatedAt });
        return jafDraft;
      }
      console.log('[DRAFT] building new draft');
      const items = await buildPreflightReport();
      jafDraft = { fingerprint, generatedAt: Date.now(), usedForFill: false, items };
      return jafDraft;
    }

    async function resolveDraftPrompts(draft) {
      const fieldByLabel = new Map([
        ...collectFillableFields().map(f => [f.label, f]),
        ...collectPreflightFields().map(f => [f.label, f]),
      ]);

      for (const item of draft.items) {
        if (!draftNeedsPrompt(item)) continue;

        const field = fieldByLabel.get(item.label);
        if (!field) continue;

        let modalOptions = [];
        let modalType = 'text';
        if (field.type === 'radio') {
          modalType = 'radio';
          modalOptions = field.options.map(o => o.label);
        } else if (field.type === 'yesno') {
          modalType = 'radio';
          modalOptions = field.options.map(o => o.label);
        } else if (field.type === 'checkbox') {
          modalType = 'checkbox';
          modalOptions = field.options.map(o => o.label);
        } else if (field.selectOptions?.length) {
          modalOptions = field.selectOptions;
          modalType = 'select';
        } else if (isDropdownField(field.el)) {
          modalOptions = await getFieldDropdownOptions(field.el);
          if (modalOptions.length) modalType = 'select';
        }

        const userAnswer = await askUserModal({ question: item.label, type: modalType, options: modalOptions });
        item.answer = userAnswer;
        item.source = 'user';
        appendToUserKnowledge(item.label, userAnswer);
        showToast(`Saved to Knowledge Base:\n"${item.label}"`);
      }
      return draft;
    }

    async function applyAnswerToField(field, answer) {
      if (isDraftPlaceholderAnswer(answer)) return false;

      if (field.type === 'text') {
        if (isGreenhousePhoneCountry(field.el)) {
          return fillField(field.el, 'United States');
        }
        return fillDropdownField(field.el, field.label, answer);
      }

      if (field.type === 'radio') {
        const match = findChoiceOption(field, answer);
        if (!match) return false;
        return await clickChoiceInput(match.el);
      }

      if (field.type === 'yesno') {
        const match = findChoiceOption(field, answer);
        if (!match) return false;
        return await clickAshbyYesNoButton(match.el, field.fieldPath);
      }

      if (field.type === 'checkbox') {
        const parts = String(answer).split(',').map(s => s.trim()).filter(Boolean);
        for (const opt of field.options) {
          if (parts.some(part => optionMatchesAnswer(opt.label, part)) && !opt.el.checked) {
            await clickChoiceInput(opt.el);
          }
        }
        return true;
      }

      return false;
    }

    async function fillFromDraft(draft) {
      const draftByLabel = new Map(
        draft.items.filter(i => !i.filled && i.answer && !isDraftPlaceholderAnswer(i.answer)).map(i => [i.label, i])
      );
      for (const field of collectFillableFields()) {
        const item = draftByLabel.get(field.label);
        if (!item) continue;
        console.log('[FILL] draft →', field.label, '=', item.answer, `(${item.source})`);
        await applyAnswerToField(field, item.answer);
      }
    }

    function sortDraftItems(items) {
      return items.slice().sort((a, b) => {
        const vertDiff = a.sortY - b.sortY;
        return Math.abs(vertDiff) > 10 ? vertDiff : (a.sortX || 0) - (b.sortX || 0);
      });
    }

    // Sync-only — never opens dropdown menus. Used to build the Claude batch list
    // without scraping every react-select upfront before the first field is filled.
    function fieldNeedsClaude(field) {
      if (field.type === 'text') {
        if (isGreenhousePhoneCountry(field.el)) return false;
        if (directValue(field.label)) return false;
        if (/^[optional[,s]+if/i.test(field.label)) return false;
        const kb = findInUserKnowledge(field.label);
        if (kb) {
          const isPlainText = !isDropdownField(field.el) && !(field.selectOptions?.length);
          if (isPlainText) return false;
          if (field.selectOptions?.length && field.selectOptions.some(o => o === kb.trim())) return false;
        }
        return true;
      }
      if (field.type === 'radio' || field.type === 'yesno') {
        const kb = findInUserKnowledge(field.label);
        if (kb && findChoiceOption(field, kb)) return false;
        return true;
      }
      if (field.type === 'checkbox') {
        if (field.options.length === 1 && (CONSENT_RE.test(field.options[0].label) || CONSENT_RE.test(field.label))) {
          return false;
        }
        const kb = findInUserKnowledge(field.label);
        if (kb) {
          const parts = kb.trim().split(',').map(s => s.trim()).filter(Boolean);
          if (parts.length > 0 && parts.every(part => field.options.some(o => optionMatchesAnswer(o.label, part)))) {
            return false;
          }
        }
        return true;
      }
      return false;
    }

    async function getClaudeAnswerForField(field, claudePromise) {
      const claudeAnswers = await claudePromise;
      const ans = claudeAnswers[field.claudeKey];
      if (ans && String(ans).trim()) return String(ans).trim();
      return '';
    }

    async function resolveFieldAnswer(field, claudePromise) {
      const base = { label: field.label, filled: false, sortY: field.sortY, sortX: field.sortX };

      if (field.type === 'text') {
        if (isGreenhousePhoneCountry(field.el)) {
          return { ...base, answer: 'United States', source: 'direct' };
        }
        const direct = directValue(field.label);
        if (direct) return { ...base, answer: direct, source: 'direct' };
        const kb = findInUserKnowledge(field.label);
        if (kb) {
          const isPlainText = !isDropdownField(field.el) && !(field.selectOptions?.length);
          const isDropdown = isDropdownField(field.el) || field.selectOptions?.length;
          if (isPlainText || isDropdown || await kbIsExactOptionMatch(field, kb)) {
            return { ...base, answer: kb.trim(), source: 'kb' };
          }
        }
        if (/^[optional[,s]+if/i.test(field.label)) {
          return { ...base, answer: 'N/A', source: 'auto' };
        }
        const trimmed = await getClaudeAnswerForField(field, claudePromise);
        return {
          ...base,
          answer: trimmed || '(will ask during fill)',
          source: trimmed ? 'claude' : 'prompt',
        };
      }

      if (field.type === 'radio' || field.type === 'yesno') {
        const kb = findInUserKnowledge(field.label);
        if (kb && await kbIsExactOptionMatch(field, kb)) {
          return { ...base, answer: kb, source: 'kb' };
        }
        const trimmed = await getClaudeAnswerForField(field, claudePromise);
        return {
          ...base,
          answer: trimmed || '(will ask during fill)',
          source: trimmed ? 'claude' : 'prompt',
        };
      }

      if (field.type === 'checkbox') {
        if (field.options.length === 1 && (CONSENT_RE.test(field.options[0].label) || CONSENT_RE.test(field.label))) {
          return { ...base, answer: field.options[0].label, source: 'auto' };
        }
        const kb = findInUserKnowledge(field.label);
        if (kb && await kbIsExactOptionMatch(field, kb)) {
          return { ...base, answer: kb, source: 'kb' };
        }
        const trimmed = await getClaudeAnswerForField(field, claudePromise);
        return {
          ...base,
          answer: trimmed || '(will ask during fill)',
          source: trimmed ? 'claude' : 'prompt',
        };
      }

      return { ...base, answer: '(will ask during fill)', source: 'prompt' };
    }

    async function promptFieldAnswer(field, item) {
      let modalOptions = [];
      let modalType = 'text';
      if (field.type === 'radio' || field.type === 'yesno') {
        modalType = 'radio';
        modalOptions = field.options.map(o => o.label);
      } else if (field.type === 'checkbox') {
        modalType = 'checkbox';
        modalOptions = field.options.map(o => o.label);
      } else if (field.selectOptions?.length) {
        modalOptions = field.selectOptions;
        modalType = 'select';
      } else if (isDropdownField(field.el)) {
        modalOptions = await getFieldDropdownOptions(field.el);
        if (modalOptions.length) modalType = 'select';
      }
      const userAnswer = await askUserModal({ question: item.label, type: modalType, options: modalOptions });
      appendToUserKnowledge(item.label, userAnswer);
      showToast(`Saved to Knowledge Base:\n"${item.label}"`);
      return { ...item, answer: userAnswer, source: 'user' };
    }

    // No cached draft: fill top-to-bottom one field at a time while building jafDraft
    // in parallel. Claude batch runs in background for fields that need it.
    async function runFillIncremental(isWorker, setLabel) {
      const fingerprint = computeFormFingerprint();
      const draftItems = collectPreflightFields()
        .filter(f => f.filled)
        .map(f => ({
          label: f.label, filled: true,
          answer: f.currentValue || '(filled)',
          source: 'current', sortY: f.sortY, sortX: f.sortX,
        }));

      const syncDraft = () => {
        jafDraft = {
          fingerprint,
          generatedAt: jafDraft?.generatedAt || Date.now(),
          usedForFill: false,
          items: sortDraftItems(draftItems),
        };
      };
      syncDraft();

      const unfilled = collectFillableFields();
      const claudeFields = unfilled.filter(f => fieldNeedsClaude(f));

      if (claudeFields.length) {
        console.log('[FILL] Claude batch started in background for', claudeFields.length, 'fields');
      }

      const claudePromise = claudeFields.length > 0
        ? callClaude(getApiKey(), claudeFields.map(f => f.claudeKey))
        : Promise.resolve({});

      for (const field of unfilled) {
        setLabel('Filling…');
        let item = await resolveFieldAnswer(field, claudePromise);

        if (draftNeedsPrompt(item)) {
          if (isWorker) window.parent.postMessage({ jaf: 'spinner-hide' }, '*');
          else hideSpinner();
          item = await promptFieldAnswer(field, item);
          if (isWorker) window.parent.postMessage({ jaf: 'spinner-show' }, '*');
          else showSpinner();
        }

        if (item.answer && !isDraftPlaceholderAnswer(item.answer)) {
          try {
            if (field.type === 'text' && isDropdownField(field.el)) {
              item.answer = await resolveExactDropdownValue(field.el, field.label, item.answer);
            }
            console.log('[FILL] →', field.label, '=', item.answer, `(${item.source})`);
            const applied = await applyAnswerToField(field, item.answer);
            if (!applied) {
              console.warn('[FILL] failed to apply:', field.label, '=', item.answer);
              if (isWorker) window.parent.postMessage({ jaf: 'spinner-hide' }, '*');
              else hideSpinner();
              item = await promptFieldAnswer(field, item);
              if (isWorker) window.parent.postMessage({ jaf: 'spinner-show' }, '*');
              else showSpinner();
              if (field.type === 'text' && isDropdownField(field.el)) {
                item.answer = await resolveExactDropdownValue(field.el, field.label, item.answer);
              }
              await applyAnswerToField(field, item.answer);
            }
          } catch (e) {
            console.error('[FILL] field error:', field.label, e);
            if (isWorker) window.parent.postMessage({ jaf: 'spinner-hide' }, '*');
            else hideSpinner();
            item = await promptFieldAnswer(field, item);
            if (isWorker) window.parent.postMessage({ jaf: 'spinner-show' }, '*');
            else showSpinner();
            if (field.type === 'text' && isDropdownField(field.el)) {
              item.answer = await resolveExactDropdownValue(field.el, field.label, item.answer);
            }
            await applyAnswerToField(field, item.answer);
          }
        }

        draftItems.push(item);
        syncDraft();
      }

      jafDraft.usedForFill = true;
    }

    async function getFieldOptionList(field) {
      if (field.type === 'radio' || field.type === 'checkbox' || field.type === 'yesno') {
        return field.options.map(o => o.label).filter(Boolean);
      }
      if (field.type === 'text') {
        if (field.selectOptions?.length) return field.selectOptions;
        if (isDropdownField(field.el)) return await getFieldDropdownOptions(field.el);
      }
      return [];
    }

    // KB is trusted immediately for plain text fields. For dropdown / radio / checkbox
    // fields the stored answer must match one option character-for-character — otherwise
    // fall through to Claude (which still reads the KB to pick the right option).
    async function kbIsExactOptionMatch(field, kbAnswer) {
      if (!kbAnswer?.trim()) return false;

      const isPlainText = field.type === 'text' &&
        !isDropdownField(field.el) && !(field.selectOptions?.length);
      if (isPlainText) return true;

      const options = await getFieldOptionList(field);
      if (!options.length) return false;

      const trimmed = kbAnswer.trim();
      if (field.type === 'checkbox') {
        const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
        return parts.length > 0 && parts.every(part => options.some(o => optionMatchesAnswer(o, part)));
      }
      if (field.type === 'radio' || field.type === 'yesno') {
        return !!findChoiceOption(field, trimmed);
      }
      return options.some(o => o === trimmed || o.toLowerCase() === trimmed.toLowerCase());
    }

    // Resolve planned answers for every field (direct map → KB exact option → Claude → prompt).
    async function buildPreflightReport() {
      const raw = collectPreflightFields();
      const report = [];
      const needsClaude = [];

      for (const f of raw) {
        if (f.filled) {
          report.push({
            label: f.label, filled: true,
            answer: f.currentValue || '(filled)',
            source: 'current', sortY: f.sortY, sortX: f.sortX,
          });
          continue;
        }

        if (f.type === 'text') {
          if (isGreenhousePhoneCountry(f.el)) {
            report.push({ label: f.label, filled: false, answer: 'United States', source: 'direct', sortY: f.sortY, sortX: f.sortX });
            continue;
          }
          const direct = directValue(f.label);
          if (direct) {
            report.push({ label: f.label, filled: false, answer: direct, source: 'direct', sortY: f.sortY, sortX: f.sortX });
            continue;
          }
          const kb = findInUserKnowledge(f.label);
          if (kb) {
            const isPlainText = !isDropdownField(f.el) && !(f.selectOptions?.length);
            const isDropdown = isDropdownField(f.el) || f.selectOptions?.length;
            if (isPlainText || isDropdown || await kbIsExactOptionMatch(f, kb)) {
              report.push({ label: f.label, filled: false, answer: kb, source: 'kb', sortY: f.sortY, sortX: f.sortX });
              continue;
            }
          }
          if (/^[optional[,s]+if\b/i.test(f.label)) {
            report.push({ label: f.label, filled: false, answer: 'N/A', source: 'auto', sortY: f.sortY, sortX: f.sortX });
            continue;
          }
          needsClaude.push(f);
        } else if (f.type === 'radio' || f.type === 'yesno') {
          const kb = findInUserKnowledge(f.label);
          if (kb && await kbIsExactOptionMatch(f, kb)) {
            report.push({ label: f.label, filled: false, answer: kb, source: 'kb', sortY: f.sortY, sortX: f.sortX });
            continue;
          }
          needsClaude.push(f);
        } else if (f.type === 'checkbox') {
          const kb = findInUserKnowledge(f.label);
          if (kb && await kbIsExactOptionMatch(f, kb)) {
            report.push({ label: f.label, filled: false, answer: kb, source: 'kb', sortY: f.sortY, sortX: f.sortX });
            continue;
          }
          needsClaude.push(f);
        }
      }

      if (needsClaude.length > 0) {
        const claudeAnswers = await callClaude(getApiKey(), needsClaude.map(f => f.claudeKey));
        for (const f of needsClaude) {
          const ans = claudeAnswers[f.claudeKey];
          const trimmed = ans && String(ans).trim() ? String(ans).trim() : '';
          report.push({
            label: f.label, filled: false,
            answer: trimmed || '(will ask during fill)',
            source: trimmed ? 'claude' : 'prompt',
            sortY: f.sortY, sortX: f.sortX,
          });
        }
      }

      report.sort((a, b) => {
        const vertDiff = a.sortY - b.sortY;
        return Math.abs(vertDiff) > 10 ? vertDiff : (a.sortX || 0) - (b.sortX || 0);
      });

      // Snap dropdown answers to exact option text (local match → Claude pick).
      const rawByLabel = new Map(raw.map(f => [f.label, f]));
      const dropdownEntries = report
        .filter(item => !item.filled && item.answer && !isDraftPlaceholderAnswer(item.answer))
        .map(item => {
          const rf = rawByLabel.get(item.label);
          if (!rf?.el || rf.type !== 'text' || !isDropdownField(rf.el)) return null;
          return { key: item.label, el: rf.el, label: item.label, answer: item.answer };
        })
        .filter(Boolean);

      if (dropdownEntries.length) {
        const normalized = await normalizeDropdownAnswers(dropdownEntries);
        for (const item of report) {
          const exact = normalized.get(item.label);
          if (exact && exact !== item.answer) item.answer = exact;
        }
      }

      return report;
    }

    // ─── Radio button group label (the question text above the options) ────────
    function getRadioGroupQuestion(el) {
      const ghQuestion = getGreenhouseApplicationQuestion(el);
      if (ghQuestion) return ghQuestion;

      // Walk up to find a fieldset legend or a preceding question element
      const fieldset = el.closest('fieldset');
      if (fieldset) {
        const legend = fieldset.querySelector('legend');
        if (legend) {
          const text = getElementText(legend);
          if (text) return cleanLabel(text);
        }
        const titleLabel = fieldset.querySelector(
          'label.ashby-application-form-question-title, label[class*="question-title"]',
        );
        if (titleLabel) {
          const text = getElementText(titleLabel);
          if (text) return cleanLabel(text);
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

      // Gem ATS: question span sits in a sibling row above the Yes/No cluster.
      function questionFromImportant(span) {
        if (!span || span.closest('label')) return '';
        const text = getElementText(span);
        if (text && text.length > 5 && !/^(yes|no)$/i.test(text.trim())) {
          return cleanLabel(text);
        }
        return '';
      }

      let node = el.parentElement;
      for (let depth = 0; depth < 12 && node; depth++) {
        const radios = node.querySelectorAll('input[type="radio"]');
        if (radios.length === 2 && [...radios].includes(el)) {
          for (const span of node.querySelectorAll('[class*="bodyImportant"]')) {
            const q = questionFromImportant(span);
            if (q) return q;
          }
          for (const child of node.children) {
            if (child.querySelector('input[type="radio"]')) continue;
            const imp = child.querySelector('[class*="bodyImportant"]');
            const q = questionFromImportant(imp);
            if (q) return q;
            const text = getElementText(child);
            if (text && text.length > 5 && !/^(yes|no)$/i.test(text.trim())) {
              return cleanLabel(text);
            }
          }
        }
        node = node.parentElement;
      }

      const wrapperLabel = getWrapperSiblingLabel(el);
      if (wrapperLabel && !/^(yes|no)$/i.test(wrapperLabel.trim())) return wrapperLabel;

      // Fallback: look for a preceding sibling or parent label text
      const parent = el.closest('div, li, section');
      if (parent) {
        const text = getElementText(parent).split('\n')[0];
        if (text && text.length < 300 && !/^(yes|no)$/i.test(text.trim())) return text;
      }
      return '';
    }
  
    // ─── Fill a field (React/Vue compatible) ──────────────────────────────────
    // Returns true if the field was successfully filled, false if the value
    // couldn't be matched (only meaningful for <select> — text/textarea always true).
    async function fillField(el, value) {
      if (!value) return false;
      const tag = el.tagName.toLowerCase();
  
      if (tag === 'select') {
        const want = value.trim().toLowerCase();
        for (const opt of el.options) {
          const optText = opt.text.trim().toLowerCase();
          const optVal = String(opt.value || '').trim().toLowerCase();
          if (optText === want || optVal === want) {
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        for (const opt of el.options) {
          if (opt.text.toLowerCase().includes(want) || String(opt.value).toLowerCase().includes(want)) {
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      } else if (tag === 'textarea') {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value);
        syncGemTextareaWrapper(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } else {
        // react-select (Greenhouse's styled dropdowns): open the field's own menu
        // and click the matching option — never a plain text fill.
        if (isReactSelect(el)) {
          return await fillReactSelect(el, value);
        }
  
        setNativeValue(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
  
        // Generic typeahead/combobox (e.g. a location autocomplete).
        const isCombobox = el.getAttribute('role') === 'combobox' ||
                           !!el.getAttribute('aria-autocomplete') ||
                           el.getAttribute('aria-haspopup') === 'listbox';
        if (isCombobox) {
          await pickDropdownOption(value);
        }
        return true;
      }
    }
  
    // ─── Field-value helpers ──────────────────────────────────────────────────
    // Set an input/textarea value through the native setter so React's value
    // tracker sees the change (a plain `el.value = …` is ignored by React).
    function setNativeValue(el, value) {
      const proto = el.tagName.toLowerCase() === 'textarea'
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    }

    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  
    // Dispatch pointer + mouse events at the center of `target`. Greenhouse's Remix
    // react-select fork commits selections on mousedown/pointerdown on the option
    // element — synthetic keyboard (Tab/Enter) only updates the visible input text.
    function fireMouseSequence(target) {
      if (!target?.getBoundingClientRect) {
        throw new Error('fireMouseSequence: target has no bounding rect');
      }
      const rect = target.getBoundingClientRect();
      const view = target.ownerDocument?.defaultView;
      if (!view) throw new Error('fireMouseSequence: target has no owner document');
      const opts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        buttons: 1,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        view,
      };
      if (view.PointerEvent) {
        target.dispatchEvent(new view.PointerEvent('pointerdown', {
          ...opts,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        }));
      }
      target.dispatchEvent(new view.MouseEvent('mousedown', opts));
      target.dispatchEvent(new view.MouseEvent('mouseup', opts));
      target.dispatchEvent(new view.MouseEvent('click', opts));
    }
  
    // True when react-select has committed a value (not just typed text in the combobox).
    function isReactSelectCommitted(inputEl) {
      const container = inputEl.closest('.select__value-container');
      if (!container) return false;
      if (container.classList.contains('select__value-container--has-value')) return true;
      const single = container.querySelector('.select__single-value');
      return !!(single && single.textContent.trim());
    }
  
    function isGreenhousePhoneCountry(el) {
      return el.id === 'country' && !!el.closest('.phone-input__country');
    }
  
    // Greenhouse's Location (City) field is an API-backed typeahead. Bulk
    // setNativeValue + 'input' does not trigger the search API — type each character
    // individually using InputEvent('insertText') so the API fires on every keystroke.
    function nodeInOverlay(overlay, node) {
      return node instanceof Node && overlay.contains(node);
    }
  
    // Inject JS into the page context so React/Greenhouse listeners receive InputEvents.
    // Tampermonkey's isolated world dispatches events the location API ignores (DIAG-LOC proved this).
    function injectPageScript(code) {
      if (typeof GM_addElement === 'undefined') {
        throw new Error('GM_addElement unavailable — required for page-context scripts');
      }
      GM_addElement('script', { textContent: code, type: 'text/javascript' });
    }

    // Ashby EEO styled radios — page context clicks (verified in DevTools console).
    function runAshbyChoiceClickInPageContext(inputId) {
      return new Promise((resolve) => {
        const reqId = 'jashby-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        const timer = setTimeout(() => {
          window.removeEventListener('jaf-ashby-choice-done', onDone);
          resolve(false);
        }, 10000);

        const onDone = (e) => {
          if (!e.detail || e.detail.reqId !== reqId) return;
          clearTimeout(timer);
          window.removeEventListener('jaf-ashby-choice-done', onDone);
          resolve(!!e.detail.ok);
        };
        window.addEventListener('jaf-ashby-choice-done', onDone);

        const inputIdJson = JSON.stringify(inputId);
        const reqIdJson = JSON.stringify(reqId);
        injectPageScript(`(function(){
    var inputId=${inputIdJson};
    var reqId=${reqIdJson};
    function done(ok){window.dispatchEvent(new CustomEvent('jaf-ashby-choice-done',{detail:{reqId:reqId,ok:!!ok}}));}
    function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
    function rowSelected(row){return !!(row&&(row.className||'').split(/\\s+/).includes('true'));}
    function findInput(){return document.getElementById(inputId);}
    function labelFor(input){
      if(!input||!input.id)return null;
      return document.querySelector('label[for="'+CSS.escape(input.id)+'"]');
    }
    function clickAt(el){
      if(!el)return;
      var r=el.getBoundingClientRect();
      var x=r.left+r.width/2,y=r.top+r.height/2;
      var t=document.elementFromPoint(x,y)||el;
      var base={bubbles:true,cancelable:true,composed:true,view:window,button:0,clientX:x,clientY:y};
      if(window.PointerEvent){
        t.dispatchEvent(new PointerEvent('pointerdown',Object.assign({pointerId:1,pointerType:'mouse',isPrimary:true},base)));
        t.dispatchEvent(new PointerEvent('pointerup',Object.assign({pointerId:1,pointerType:'mouse',isPrimary:true},base)));
      }
      t.dispatchEvent(new MouseEvent('mousedown',base));
      t.dispatchEvent(new MouseEvent('mouseup',base));
      t.dispatchEvent(new MouseEvent('click',base));
      if(typeof t.click==='function')t.click();
    }
    async function trySelect(){
      var input=findInput();
      if(!input){done(false);return;}
      var label=labelFor(input);
      if(!label){done(false);return;}
      label.scrollIntoView({block:'center',behavior:'instant'});
      await sleep(200);
      label.click();
      await sleep(350);
      input=findInput();
      var row=input&&input.closest('[class*="_option_"]');
      done(rowSelected(row));
    }
    trySelect();
    })();`);
      });
    }

    // Ashby Yes/No button groups (e.g. sponsorship question).
    function runAshbyYesNoClickInPageContext(fieldPath, buttonLabel) {
      return new Promise((resolve) => {
        const reqId = 'jashbyno-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        const timer = setTimeout(() => {
          window.removeEventListener('jaf-ashby-yesno-done', onDone);
          resolve(false);
        }, 10000);

        const onDone = (e) => {
          if (!e.detail || e.detail.reqId !== reqId) return;
          clearTimeout(timer);
          window.removeEventListener('jaf-ashby-yesno-done', onDone);
          resolve(!!e.detail.ok);
        };
        window.addEventListener('jaf-ashby-yesno-done', onDone);

        const fieldPathJson = JSON.stringify(fieldPath);
        const buttonLabelJson = JSON.stringify(buttonLabel);
        const reqIdJson = JSON.stringify(reqId);
        injectPageScript(`(function(){
    var fieldPath=${fieldPathJson};
    var buttonLabel=${buttonLabelJson};
    var reqId=${reqIdJson};
    function done(ok){window.dispatchEvent(new CustomEvent('jaf-ashby-yesno-done',{detail:{reqId:reqId,ok:!!ok}}));}
    function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
    function btnSelected(btn){
      if(!btn)return false;
      if(btn.getAttribute('aria-pressed')==='true')return true;
      if((btn.className||'').split(/\\s+/).includes('true'))return true;
      return /selected|active|checked/i.test(btn.className||'');
    }
    function findEntry(){
      return Array.from(document.querySelectorAll('[data-field-path]'))
        .find(function(el){return el.getAttribute('data-field-path')===fieldPath;});
    }
    function findBtn(entry){
      if(!entry)return null;
      return Array.from(entry.querySelectorAll('button')).find(function(b){
        return b.textContent.trim()===buttonLabel;
      });
    }
    function clickAt(el){
      if(!el)return;
      var r=el.getBoundingClientRect();
      var x=r.left+r.width/2,y=r.top+r.height/2;
      var t=document.elementFromPoint(x,y)||el;
      var base={bubbles:true,cancelable:true,composed:true,view:window,button:0,clientX:x,clientY:y};
      if(window.PointerEvent){
        t.dispatchEvent(new PointerEvent('pointerdown',Object.assign({pointerId:1,pointerType:'mouse',isPrimary:true},base)));
        t.dispatchEvent(new PointerEvent('pointerup',Object.assign({pointerId:1,pointerType:'mouse',isPrimary:true},base)));
      }
      t.dispatchEvent(new MouseEvent('mousedown',base));
      t.dispatchEvent(new MouseEvent('mouseup',base));
      t.dispatchEvent(new MouseEvent('click',base));
      if(typeof t.click==='function')t.click();
    }
    async function trySelect(){
      var entry=findEntry();
      var btn=findBtn(entry);
      if(!btn){done(false);return;}
      btn.scrollIntoView({block:'center',behavior:'instant'});
      await sleep(200);
      btn=findBtn(findEntry());
      if(!btn){done(false);return;}
      btn.click();
      await sleep(350);
      btn=findBtn(findEntry());
      done(btnSelected(btn));
    }
    trySelect();
    })();`);
      });
    }
  
    function runGreenhouseLocationInPageContext(cityName) {
      return new Promise((resolve, reject) => {
        const reqId = 'jloc-' + Date.now();
        const timer = setTimeout(() => {
          window.removeEventListener('jaf-greenhouse-location-done', onDone);
          reject(new Error('page-context location fill timed out (35s)'));
        }, 35000);
  
        const onDone = (e) => {
          if (!e.detail || e.detail.reqId !== reqId) return;
          clearTimeout(timer);
          window.removeEventListener('jaf-greenhouse-location-done', onDone);
          resolve(e.detail);
        };
        window.addEventListener('jaf-greenhouse-location-done', onDone);
  
        const cityJson = JSON.stringify(cityName);
        const idJson = JSON.stringify(reqId);
        injectPageScript(`(function(){
    var cityName=${cityJson};
    var reqId=${idJson};
    var cityLow=cityName.toLowerCase();
    function done(detail){window.dispatchEvent(new CustomEvent('jaf-greenhouse-location-done',{detail:detail}));}
  
    function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
    function visible(o){var r=o.getBoundingClientRect();return r.width>0&&r.height>0;}
    function countOptions(el){
      var controlsId=el.getAttribute('aria-controls');
      var scope=controlsId?document.getElementById(controlsId):null;
      var opts=scope
        ?Array.from(scope.querySelectorAll('[role="option"]')).filter(visible)
        :Array.from(document.querySelectorAll('[role="option"]')).filter(visible);
      return opts.length;
    }
    function isCommitted(el){
      var c=el.closest('.select__value-container');
      if(!c)return false;
      if(c.classList.contains('select__value-container--has-value'))return true;
      var single=c.querySelector('.select__single-value');
      if(!single||!single.textContent.trim())return false;
      var t=single.textContent.trim().toLowerCase();
      return t.indexOf(cityLow+',')===0||t.indexOf(cityLow)===0;
    }
    function dispatchKey(el,key,code,keyCode){
      var base={key:key,code:code,keyCode:keyCode,which:keyCode,bubbles:true,cancelable:true,composed:true};
      el.dispatchEvent(new KeyboardEvent('keydown',base));
      el.dispatchEvent(new KeyboardEvent('keypress',base));
      el.dispatchEvent(new KeyboardEvent('keyup',base));
    }
    function arrowDown(el){dispatchKey(el,'ArrowDown','ArrowDown',40);}
    async function prepField(el,wrapper){
      var control=wrapper&&wrapper.querySelector('.select__control');
      var toggle=wrapper&&wrapper.querySelector('[aria-label="Toggle flyout"]');
      if(toggle)toggle.click();
      else if(control)control.click();
      el.focus();el.click();
      await sleep(150);
      if(el.getAttribute('aria-expanded')!=='true')arrowDown(el);
      await sleep(100);
    }
    async function typeCityInput(el){
      var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      document.execCommand('selectAll',false,null);
      document.execCommand('delete',false,null);
      await sleep(200);
      setter.call(el,cityName);
      el.dispatchEvent(new InputEvent('input',{
        bubbles:true,composed:true,cancelable:true,inputType:'insertText',data:cityName
      }));
    }
    async function waitForMenu(el,maxMs){
      var start=Date.now();
      while(Date.now()-start<maxMs){
        var n=countOptions(el);
        if(el.getAttribute('aria-expanded')==='true'||n>0)return true;
        await sleep(100);
      }
      return false;
    }
    async function ensureMenu(el){
      if(await waitForMenu(el,6000))return true;
      arrowDown(el);await sleep(200);
      if(await waitForMenu(el,2000))return true;
      arrowDown(el);await sleep(200);
      return await waitForMenu(el,1500);
    }
    function findOption(el){
      var controlsId=el.getAttribute('aria-controls');
      var scope=controlsId?document.getElementById(controlsId):null;
      var opts=scope
        ?Array.from(scope.querySelectorAll('[role="option"]')).filter(visible)
        :Array.from(document.querySelectorAll('[role="option"]')).filter(visible);
      if(!opts.length)return null;
      var txt=function(o){return o.textContent.trim().toLowerCase();};
      return opts.find(function(o){return txt(o).indexOf(cityLow+',')===0;})
          ||opts.find(function(o){return txt(o).indexOf(cityLow)===0;})
          ||null;
    }
    function clickOption(opt){
      var r=opt.getBoundingClientRect();
      var x=r.left+r.width/2,y=r.top+r.height/2;
      var t=document.elementFromPoint(x,y)||opt;
      var base={bubbles:true,cancelable:true,composed:true,view:window,button:0,clientX:x,clientY:y};
      t.dispatchEvent(new MouseEvent('mousedown',base));
      t.dispatchEvent(new MouseEvent('mouseup',base));
      t.dispatchEvent(new MouseEvent('click',base));
    }
    (async function(){
      try{
        var el=document.getElementById('candidate-location');
        if(!el){done({reqId:reqId,ok:false,reason:'no-element'});return;}
        var wrapper=el.closest('.field-wrapper')||el.closest('.select');
        wrapper&&wrapper.scrollIntoView({block:'center',inline:'nearest'});
        await sleep(200);
        await prepField(el,wrapper);
        await typeCityInput(el);
        if(!await ensureMenu(el)){
          done({reqId:reqId,ok:false,reason:'menu-never-opened',combobox:el.value,expanded:el.getAttribute('aria-expanded')});
          return;
        }
        await sleep(1200);
        if(isCommitted(el)){done({reqId:reqId,ok:true,via:'auto',combobox:el.value});return;}
  
        var opt=null;
        for(var j=0;j<60;j++){
          opt=findOption(el);
          if(opt||isCommitted(el))break;
          await sleep(100);
        }
        if(isCommitted(el)){done({reqId:reqId,ok:true,via:'poll',combobox:el.value});return;}
  
        if(opt){
          clickOption(opt);
          await sleep(500);
          if(isCommitted(el)){
            done({reqId:reqId,ok:true,via:'click',option:opt.textContent.trim(),combobox:el.value});
            return;
          }
        }
  
        // No real match found — do NOT blind-commit the highlighted/first option.
        done({reqId:reqId,ok:false,reason:'no-commit',combobox:el.value,expanded:el.getAttribute('aria-expanded')});
      }catch(err){
        done({reqId:reqId,ok:false,reason:'error',message:String(err)});
      }
    })();
  })();`);
      });
    }
  
    function runGreenhousePhoneCountryInPageContext(searchText) {
      return new Promise((resolve, reject) => {
        const reqId = 'jpc-' + Date.now();
        const timer = setTimeout(() => {
          window.removeEventListener('jaf-greenhouse-phone-country-done', onDone);
          reject(new Error('page-context phone country fill timed out (20s)'));
        }, 20000);
  
        const onDone = (e) => {
          if (!e.detail || e.detail.reqId !== reqId) return;
          clearTimeout(timer);
          window.removeEventListener('jaf-greenhouse-phone-country-done', onDone);
          resolve(e.detail);
        };
        window.addEventListener('jaf-greenhouse-phone-country-done', onDone);
  
        const searchJson = JSON.stringify((searchText || 'United States').replace(/\s*\([^)]*\)\s*$/, '').trim() || 'United States');
        const idJson = JSON.stringify(reqId);
        injectPageScript(`(function(){
    var searchText=${searchJson};
    var reqId=${idJson};
    function done(detail){window.dispatchEvent(new CustomEvent('jaf-greenhouse-phone-country-done',{detail:detail}));}
  
    function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
    function visible(o){var r=o.getBoundingClientRect();return r.width>0&&r.height>0;}
    function countOptions(el){
      var controlsId=el.getAttribute('aria-controls');
      var scope=controlsId?document.getElementById(controlsId):null;
      var opts=scope
        ?Array.from(scope.querySelectorAll('[role="option"]')).filter(visible)
        :Array.from(document.querySelectorAll('[role="option"]')).filter(visible);
      return opts.length;
    }
    function isOk(el){
      if(el.getAttribute('aria-invalid')==='true')return false;
      var err=document.getElementById('country-error');
      if(err&&err.textContent.trim())return false;
      var c=el.closest('.select__value-container');
      if(!c)return false;
      var single=c.querySelector('.select__single-value');
      if(!single)return false;
      var t=single.textContent.replace(/\\s+/g,' ').trim().toLowerCase();
      return t.indexOf('+1')>=0||t.indexOf('united states')>=0;
    }
    function dispatchKey(el,key,code,keyCode){
      var base={key:key,code:code,keyCode:keyCode,which:keyCode,bubbles:true,cancelable:true,composed:true};
      el.dispatchEvent(new KeyboardEvent('keydown',base));
      el.dispatchEvent(new KeyboardEvent('keypress',base));
      el.dispatchEvent(new KeyboardEvent('keyup',base));
    }
    function arrowDown(el){dispatchKey(el,'ArrowDown','ArrowDown',40);}
    function pressTab(el){
      var base={key:'Tab',code:'Tab',keyCode:9,which:9,bubbles:true,cancelable:true,composed:true};
      el.dispatchEvent(new KeyboardEvent('keydown',base));
      el.dispatchEvent(new KeyboardEvent('keyup',base));
    }
    async function prepField(el,wrapper){
      var control=wrapper&&wrapper.querySelector('.select__control');
      var toggle=wrapper&&wrapper.querySelector('[aria-label="Toggle flyout"]');
      if(toggle)toggle.click();
      else if(control)control.click();
      el.focus();el.click();
      await sleep(150);
      if(el.getAttribute('aria-expanded')!=='true')arrowDown(el);
      await sleep(100);
    }
    async function typeKeyboard(el,text){
      document.execCommand('selectAll',false,null);
      document.execCommand('delete',false,null);
      await sleep(200);
      for(var i=0;i<text.length;i++){
        var ch=text[i];
        if(ch===' ')dispatchKey(el,' ','Space',32);
        else dispatchKey(el,ch,'Key'+ch.toUpperCase(),ch.charCodeAt(0));
        await sleep(45);
      }
    }
    async function waitForMenu(el,maxMs){
      var start=Date.now();
      while(Date.now()-start<maxMs){
        var n=countOptions(el);
        if(el.getAttribute('aria-expanded')==='true'||n>0)return true;
        await sleep(100);
      }
      return false;
    }
    async function ensureMenu(el){
      if(await waitForMenu(el,2500))return true;
      arrowDown(el);await sleep(200);
      if(await waitForMenu(el,1000))return true;
      arrowDown(el);await sleep(200);
      return await waitForMenu(el,800);
    }
  
    (async function(){
      try{
        var el=document.getElementById('country');
        if(!el||!el.closest('.phone-input__country')){done({reqId:reqId,ok:false,reason:'no-element'});return;}
        var wrapper=el.closest('.phone-input__country');
        wrapper&&wrapper.scrollIntoView({block:'center',inline:'nearest'});
        await prepField(el,wrapper);
        await typeKeyboard(el,searchText);
        if(!await ensureMenu(el)){
          done({reqId:reqId,ok:false,reason:'menu-never-opened',expanded:el.getAttribute('aria-expanded')});
          return;
        }
        pressTab(el);
        await sleep(200);
        done({reqId:reqId,ok:isOk(el),via:'tab',expanded:el.getAttribute('aria-expanded')});
      }catch(err){
        done({reqId:reqId,ok:false,reason:'error',message:String(err)});
      }
    })();
  })();`);
      });
    }
  
    function runGreenhouseReactSelectInPageContext(fieldId, searchText) {
      return new Promise((resolve, reject) => {
        const reqId = 'jrs-' + Date.now();
        const timer = setTimeout(() => {
          window.removeEventListener('jaf-greenhouse-react-select-done', onDone);
          reject(new Error('page-context react-select fill timed out (15s)'));
        }, 15000);
  
        const onDone = (e) => {
          if (!e.detail || e.detail.reqId !== reqId) return;
          clearTimeout(timer);
          window.removeEventListener('jaf-greenhouse-react-select-done', onDone);
          resolve(e.detail);
        };
        window.addEventListener('jaf-greenhouse-react-select-done', onDone);
  
        const fieldIdJson = JSON.stringify(fieldId);
        const searchJson = JSON.stringify(searchText);
        const idJson = JSON.stringify(reqId);
        injectPageScript(`(function(){
    var fieldId=${fieldIdJson};
    var searchText=${searchJson};
    var reqId=${idJson};
    var want=searchText.toLowerCase();
    function done(detail){window.dispatchEvent(new CustomEvent('jaf-greenhouse-react-select-done',{detail:detail}));}
    function fieldLabel(el){
      var labelId=el.getAttribute('aria-labelledby');
      if(labelId){var lbl=document.getElementById(labelId);if(lbl)return(lbl.textContent||'').toLowerCase();}
      var w=el.closest('.field-wrapper');
      if(w){var l=w.querySelector('label');if(l)return(l.textContent||'').toLowerCase();}
      return '';
    }
    function isAsyncSearchField(el){
      var t=fieldLabel(el);
      return /\\bschool\\b|\\bdegree\\b|\\buniversity\\b|\\bcollege\\b|\\bemployer\\b|\\bcompany\\b|\\borganization\\b|\\bdiscipline\\b/.test(t);
    }
    function committedMatchesWant(t){
      if(t===want)return true;
      if(t.indexOf(want)===0&&(t.length===want.length||/[\\s,]/.test(t.charAt(want.length))))return true;
      return false;
    }
  
    function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
    function visible(o){var r=o.getBoundingClientRect();return r.width>0&&r.height>0;}
    function hasChipStructure(el){
      var c=el.closest('.select__value-container');
      if(!c)return false;
      return !!(c.querySelector('.select__multi-value,.select__multi-value__label,.select__multi-value__remove'));
    }
    function isMultiByLabel(el){
      var labelId=el.getAttribute('aria-labelledby');
      if(!labelId)return false;
      var lbl=document.getElementById(labelId);
      if(!lbl)return false;
      var t=(lbl.textContent||'').toLowerCase();
      return /identify your ethnicity|select all that apply|choose all that apply/i.test(t);
    }
    function isMultiFromMenu(el){
      var controlsId=el.getAttribute('aria-controls');
      if(!controlsId)return false;
      var lb=document.getElementById(controlsId);
      return !!(lb&&lb.getAttribute('aria-multiselectable')==='true');
    }
    function isMultiSelect(el){
      if(hasChipStructure(el))return true;
      if(isMultiByLabel(el))return true;
      if(isMultiFromMenu(el))return true;
      var c=el.closest('.select__value-container');
      if(!c)return false;
      if(c.querySelector('.select__single-value'))return false;
      var root=el.closest('.select')||el.closest('.select-shell');
      if(root){
        var ctl=root.querySelector('.select__control');
        if(ctl){
          for(var i=0;i<ctl.classList.length;i++){
            if(/is-multi|multi/i.test(ctl.classList[i]))return true;
          }
        }
      }
      return false;
    }
    function getChipLabels(el){
      var c=el.closest('.select__value-container');
      if(!c)return [];
      return Array.from(c.querySelectorAll('.select__multi-value__label'))
        .map(function(n){return n.textContent.trim().toLowerCase();}).filter(Boolean);
    }
    function isTargetCommitted(el){
      var c=el.closest('.select__value-container');
      if(!c)return false;
      if(isMultiSelect(el)){
        var chips=getChipLabels(el);
        return chips.length===1&&chips[0]===want;
      }
      var single=c.querySelector('.select__single-value');
      if(single)return committedMatchesWant(single.textContent.trim().toLowerCase());
      return false;
    }
    async function clearMultiSelectChips(el){
      var c=el.closest('.select__value-container');
      if(!c)return;
      for(var n=0;n<20;n++){
        var btn=c.querySelector('.select__multi-value__remove');
        if(!btn)break;
        btn.click();
        await sleep(150);
      }
    }
    function getOptions(el,strictScope){
      var opts=[];
      var controlsId=el.getAttribute('aria-controls');
      if(controlsId){
        var scope=document.getElementById(controlsId);
        if(scope)opts=Array.from(scope.querySelectorAll('[role="option"]')).filter(visible);
      }
      if(!opts.length)opts=Array.from(document.querySelectorAll('[id^="react-select-'+fieldId+'-option"]')).filter(visible);
      if(!strictScope&&!opts.length)opts=Array.from(document.querySelectorAll('[role="option"]')).filter(visible);
      return opts;
    }
    function countOptions(el){return getOptions(el,false).length;}
    function findOption(el,exactOnly){
      var strict=exactOnly||isAsyncSearchField(el);
      var opts=getOptions(el,strict);
      if(!opts.length)return null;
      var txt=function(o){return o.textContent.trim().toLowerCase();};
      var exact=opts.find(function(o){return txt(o)===want;});
      if(exact)return exact;
      if(exactOnly||strict)return null;
      var starts=opts.find(function(o){return txt(o).startsWith(want);});
      if(starts)return starts;
      var prefix=opts.filter(function(o){return want.startsWith(txt(o))&&txt(o).length>2;});
      if(prefix.length===1)return prefix[0];
      return null;
    }
    function dispatchKey(el,key,code,keyCode){
      var base={key:key,code:code,keyCode:keyCode,which:keyCode,bubbles:true,cancelable:true,composed:true};
      el.dispatchEvent(new KeyboardEvent('keydown',base));
      el.dispatchEvent(new KeyboardEvent('keypress',base));
      el.dispatchEvent(new KeyboardEvent('keyup',base));
    }
    function arrowDown(el){dispatchKey(el,'ArrowDown','ArrowDown',40);}
    function fireFullClick(target){
      target.scrollIntoView({block:'nearest'});
      var r=target.getBoundingClientRect();
      var x=r.left+r.width/2,y=r.top+r.height/2;
      var t=document.elementFromPoint(x,y)||target;
      var base={bubbles:true,cancelable:true,composed:true,view:window,button:0,buttons:1,clientX:x,clientY:y};
      if(window.PointerEvent)t.dispatchEvent(new PointerEvent('pointerdown',Object.assign({pointerId:1,pointerType:'mouse',isPrimary:true},base)));
      t.dispatchEvent(new MouseEvent('mousedown',base));
      t.dispatchEvent(new MouseEvent('mouseup',base));
      t.dispatchEvent(new MouseEvent('click',base));
    }
    async function openMenu(el,wrapper){
      wrapper&&wrapper.scrollIntoView({block:'center',inline:'nearest'});
      await sleep(200);
      var indicator=wrapper&&wrapper.querySelector('.select__dropdown-indicator,.select__indicator');
      var control=wrapper&&wrapper.querySelector('.select__control');
      var toggle=wrapper&&wrapper.querySelector('[aria-label="Toggle flyout"]');
      if(indicator)fireFullClick(indicator);
      else if(toggle)fireFullClick(toggle);
      else if(control)fireFullClick(control);
      el.focus();
      await sleep(500);
      if(getOptions(el).length===0)arrowDown(el);
      await sleep(400);
    }
    async function prepField(el,wrapper,multi){
      await openMenu(el,wrapper);
    }
    async function typeSearchInput(el,text){
      var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      document.execCommand('selectAll',false,null);
      document.execCommand('delete',false,null);
      await sleep(200);
      setter.call(el,text);
      el.dispatchEvent(new InputEvent('input',{
        bubbles:true,composed:true,cancelable:true,inputType:'insertText',data:text
      }));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    }
    async function typeKeyboard(el,text){
      document.execCommand('selectAll',false,null);
      document.execCommand('delete',false,null);
      await sleep(200);
      for(var i=0;i<text.length;i++){
        var ch=text[i];
        if(ch===' ')dispatchKey(el,' ','Space',32);
        else dispatchKey(el,ch,'Key'+ch.toUpperCase(),ch.charCodeAt(0));
        await sleep(45);
      }
    }
    async function waitForExactOption(el,maxMs){
      var start=Date.now();
      while(Date.now()-start<maxMs){
        if(findOption(el,true))return true;
        if(isTargetCommitted(el))return true;
        await sleep(100);
      }
      return !!findOption(el,true);
    }
    async function waitForMenu(el,maxMs){
      var start=Date.now();
      while(Date.now()-start<maxMs){
        if(el.getAttribute('aria-expanded')==='true'||countOptions(el)>0)return true;
        await sleep(100);
      }
      return false;
    }
    async function ensureMenu(el){
      if(await waitForMenu(el,2500))return true;
      arrowDown(el);await sleep(200);
      if(await waitForMenu(el,1000))return true;
      arrowDown(el);await sleep(200);
      return await waitForMenu(el,800);
    }
    function clickOption(opt){
      var r=opt.getBoundingClientRect();
      var x=r.left+r.width/2,y=r.top+r.height/2;
      var t=document.elementFromPoint(x,y)||opt;
      var base={bubbles:true,cancelable:true,composed:true,view:window,button:0,buttons:1,clientX:x,clientY:y};
      if(window.PointerEvent)t.dispatchEvent(new PointerEvent('pointerdown',Object.assign({pointerId:1,pointerType:'mouse',isPrimary:true},base)));
      t.dispatchEvent(new MouseEvent('mousedown',base));
    }
    async function commitMultiSelect(el,wrapper){
      if(isTargetCommitted(el))return 'already';
      var opts=getOptions(el);
      var targetIdx=-1;
      for(var i=0;i<opts.length;i++){
        if(opts[i].textContent.trim().toLowerCase()===want){targetIdx=i;break;}
      }
      if(targetIdx<0)return null;
      fireFullClick(opts[targetIdx]);
      await sleep(600);
      if(isTargetCommitted(el))return 'click';
      await clearMultiSelectChips(el);
      await openMenu(el,wrapper);
      el.focus();await sleep(300);
      for(var j=0;j<targetIdx;j++){dispatchKey(el,'ArrowDown','ArrowDown',40);await sleep(120);}
      dispatchKey(el,'Enter','Enter',13);
      await sleep(600);
      if(isTargetCommitted(el))return 'keyboard-enter';
      await clearMultiSelectChips(el);
      await openMenu(el,wrapper);
      el.focus();await sleep(300);
      for(var k=0;k<targetIdx;k++){dispatchKey(el,'ArrowDown','ArrowDown',40);await sleep(120);}
      dispatchKey(el,' ','Space',32);
      await sleep(600);
      if(isTargetCommitted(el))return 'keyboard-space';
      return null;
    }
    async function commitSelection(el){
      if(isTargetCommitted(el))return 'already';
      var opt=findOption(el,isAsyncSearchField(el));
      if(!opt)return null;
      clickOption(opt);
      await sleep(400);
      if(isTargetCommitted(el))return 'click';
      var opt2=findOption(el,isAsyncSearchField(el));
      if(opt2){
        var r=opt2.getBoundingClientRect();
        var x=r.left+r.width/2,y=r.top+r.height/2;
        var t=document.elementFromPoint(x,y)||opt2;
        var base={bubbles:true,cancelable:true,composed:true,view:window,button:0,clientX:x,clientY:y};
        t.dispatchEvent(new MouseEvent('mouseup',base));
        t.dispatchEvent(new MouseEvent('click',base));
        await sleep(400);
        if(isTargetCommitted(el))return 'click2';
      }
      return null;
    }
  
    (async function(){
      try{
        var el=document.getElementById(fieldId);
        if(!el){done({reqId:reqId,ok:false,reason:'no-element',fieldId:fieldId});return;}
        var wrapper=el.closest('.field-wrapper')||el.closest('.select')||el.closest('.select-shell');
        wrapper&&wrapper.scrollIntoView({block:'center',inline:'nearest'});
        await openMenu(el,wrapper);
        var multi=isMultiSelect(el);
        if(multi&&!isTargetCommitted(el))await clearMultiSelectChips(el);
        if(isTargetCommitted(el)){
          done({reqId:reqId,ok:true,fieldId:fieldId,via:'already',multi:multi,
            searchText:searchText,chips:getChipLabels(el).join('|')});
          return;
        }
        var menuOpen=getOptions(el).length>0||await ensureMenu(el);
        if(!menuOpen){
          done({reqId:reqId,ok:false,reason:'menu-never-opened',fieldId:fieldId,expanded:el.getAttribute('aria-expanded'),multi:multi});
          return;
        }
        if(!multi&&isMultiFromMenu(el))multi=true;
        if(!multi&&!isTargetCommitted(el)){
          var asyncSearch=isAsyncSearchField(el);
          if(asyncSearch){
            await typeSearchInput(el,searchText);
            menuOpen=await ensureMenu(el);
            if(!menuOpen){
              done({reqId:reqId,ok:false,reason:'menu-never-opened',fieldId:fieldId,expanded:el.getAttribute('aria-expanded'),multi:multi});
              return;
            }
            await waitForExactOption(el,2500);
          }else{
            await typeKeyboard(el,searchText);
            menuOpen=await ensureMenu(el);
            if(!menuOpen){
              done({reqId:reqId,ok:false,reason:'menu-never-opened',fieldId:fieldId,expanded:el.getAttribute('aria-expanded'),multi:multi});
              return;
            }
          }
        }
        var via=multi?await commitMultiSelect(el,wrapper):await commitSelection(el);
        if(multi)dispatchKey(el,'Escape','Escape',27);
        done({
          reqId:reqId,ok:!!via,fieldId:fieldId,via:via||'none',multi:multi,
          searchText:searchText,chips:getChipLabels(el).join('|'),
          expanded:el.getAttribute('aria-expanded')
        });
      }catch(err){
        done({reqId:reqId,ok:false,reason:'error',fieldId:fieldId,message:String(err)});
      }
    })();
  })();`);
      });
    }

    // Open a react-select menu and scrape option labels (for preflight + exact matching).
    function runCollectReactSelectOptionsInPageContext(fieldId) {
      return new Promise((resolve, reject) => {
        const reqId = 'jrs-opts-' + Date.now();
        const timer = setTimeout(() => {
          window.removeEventListener('jaf-greenhouse-react-select-options-done', onDone);
          reject(new Error('react-select option collect timed out (10s)'));
        }, 10000);

        const onDone = (e) => {
          if (!e.detail || e.detail.reqId !== reqId) return;
          clearTimeout(timer);
          window.removeEventListener('jaf-greenhouse-react-select-options-done', onDone);
          resolve(e.detail);
        };
        window.addEventListener('jaf-greenhouse-react-select-options-done', onDone);

        injectPageScript(`(function(){
    var fieldId=${JSON.stringify(fieldId)};
    var reqId=${JSON.stringify(reqId)};
    function done(d){window.dispatchEvent(new CustomEvent('jaf-greenhouse-react-select-options-done',{detail:d}));}
    function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
    function visible(o){var r=o.getBoundingClientRect();return r.width>0&&r.height>0;}
    function dispatchKey(el,key,code,keyCode){
      var base={key:key,code:code,keyCode:keyCode,which:keyCode,bubbles:true,cancelable:true,composed:true};
      el.dispatchEvent(new KeyboardEvent('keydown',base));
      el.dispatchEvent(new KeyboardEvent('keyup',base));
    }
    function arrowDown(el){dispatchKey(el,'ArrowDown','ArrowDown',40);}
    function fireFullClick(target){
      var r=target.getBoundingClientRect();
      var x=r.left+r.width/2,y=r.top+r.height/2;
      var t=document.elementFromPoint(x,y)||target;
      var base={bubbles:true,cancelable:true,composed:true,view:window,button:0,buttons:1,clientX:x,clientY:y};
      if(window.PointerEvent)t.dispatchEvent(new PointerEvent('pointerdown',Object.assign({pointerId:1,pointerType:'mouse',isPrimary:true},base)));
      t.dispatchEvent(new MouseEvent('mousedown',base));
      t.dispatchEvent(new MouseEvent('mouseup',base));
      t.dispatchEvent(new MouseEvent('click',base));
    }
    async function prepField(el,wrapper){
      wrapper&&wrapper.scrollIntoView({block:'center',inline:'nearest'});
      await sleep(200);
      var indicator=wrapper&&wrapper.querySelector('.select__dropdown-indicator,.select__indicator');
      var control=wrapper&&wrapper.querySelector('.select__control');
      var toggle=wrapper&&wrapper.querySelector('[aria-label="Toggle flyout"]');
      if(indicator)fireFullClick(indicator);
      else if(toggle)fireFullClick(toggle);
      else if(control)fireFullClick(control);
      el.focus();
      await sleep(500);
      if(el.getAttribute('aria-expanded')!=='true')arrowDown(el);
      await sleep(400);
    }
    function collectOptions(el){
      var opts=[];
      var controlsId=el.getAttribute('aria-controls');
      if(controlsId){
        var scope=document.getElementById(controlsId);
        if(scope)opts=Array.from(scope.querySelectorAll('[role="option"]')).filter(visible);
      }
      if(!opts.length)opts=Array.from(document.querySelectorAll('[id^="react-select-'+fieldId+'-option"]')).filter(visible);
      if(!opts.length)opts=Array.from(document.querySelectorAll('[role="option"]')).filter(visible);
      return opts.map(function(o){return o.textContent.trim();}).filter(Boolean);
    }
    async function waitForMenu(el,maxMs){
      var start=Date.now();
      while(Date.now()-start<maxMs){
        if(el.getAttribute('aria-expanded')==='true'||collectOptions(el).length>0)return true;
        await sleep(100);
      }
      return false;
    }
    (async function(){
      try{
        var el=document.getElementById(fieldId);
        if(!el){done({reqId:reqId,ok:false,options:[]});return;}
        var wrapper=el.closest('.field-wrapper')||el.closest('.select')||el.closest('.select-shell');
        await prepField(el,wrapper);
        var menuOpen=await waitForMenu(el,2500);
        if(!menuOpen){arrowDown(el);await sleep(200);menuOpen=await waitForMenu(el,1000);}
        var options=collectOptions(el);
        dispatchKey(el,'Escape','Escape',27);
        document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,bubbles:true}));
        await sleep(100);
        done({reqId:reqId,ok:options.length>0,options:options});
      }catch(err){
        done({reqId:reqId,ok:false,options:[],message:String(err)});
      }
    })();
  })();`);
      });
    }
  
    async function fillGreenhousePhoneCountry(el, value) {
      const searchText = (value || 'United States').replace(/\s*\([^)]*\)\s*$/, '').trim() || 'United States';
      const isWorker = getFrameRole() === 'worker';
      if (isWorker) window.parent.postMessage({ jaf: 'spinner-hide' }, '*');
  
      try {
        const result = await runGreenhousePhoneCountryInPageContext(searchText);
        if (result.ok) return true;
        console.warn('[job-fill] fillGreenhousePhoneCountry failed:', result);
        showToast('Phone country: pick United States (+1) from the dropdown.');
        return false;
      } catch (e) {
        console.warn('[job-fill] fillGreenhousePhoneCountry:', e);
        showToast('Phone country: pick United States (+1) from the dropdown.');
        return false;
      }
    }
  
    // Temporary diagnostics for Greenhouse location typeahead — filter console with [DIAG-LOC].
    function diagLoc(step, data) {
      console.log('[DIAG-LOC]', step, data);
    }
  
    async function fillGreenhouseLocation(el, value) {
      const cityName = value.split(',')[0].trim() || 'San Francisco';
      const isWorker = getFrameRole() === 'worker';
  
      diagLoc('0-start', { cityName, rawValue: value, mode: 'page-context', frame: getFrameRole() });
  
      if (isWorker) window.parent.postMessage({ jaf: 'spinner-hide' }, '*');
  
      try {
        const result = await runGreenhouseLocationInPageContext(cityName);
        diagLoc('done-page-context', result);
        if (result.ok) return true;
        console.warn('[job-fill] fillGreenhouseLocation failed:', result);
        showToast('Location: please manually pick the first dropdown option, then click Fill again.');
        return false;
      } catch (e) {
        diagLoc('error-page-context', { message: e.message });
        console.warn('[job-fill] fillGreenhouseLocation:', e);
        showToast('Location: please manually pick the first dropdown option, then click Fill again.');
        return false;
      }
    }
  
    // Greenhouse's dropdowns are react-select instances: a text <input role="combobox">
    // whose options live in a portal menu identified by the field id. A live-region
    // span (react-select-<id>-live-region) exists even while the menu is closed, so
    // we can detect react-select reliably up front.
    function isReactSelect(el) {
      if (el.classList.contains('select__input')) return true;
      const id = el.id;
      return el.getAttribute('role') === 'combobox' && !!id &&
        !!document.getElementById(`react-select-${id}-live-region`);
    }

    function isDropdownField(el) {
      if (!el) return false;
      if (el.tagName.toLowerCase() === 'select') return true;
      return isReactSelect(el);
    }

    async function getFieldDropdownOptions(el) {
      if (!el) return [];
      if (el.tagName.toLowerCase() === 'select') {
        const firstText = (el.options[0]?.text || '').toLowerCase();
        const skipFirst = firstText.startsWith('select') || firstText.startsWith('choose') || firstText.startsWith('please');
        return Array.from(el.options).slice(skipFirst ? 1 : 0).map(o => o.text.trim()).filter(Boolean);
      }
      if (isReactSelect(el)) {
        const result = await runCollectReactSelectOptionsInPageContext(el.id);
        return result.options || [];
      }
      return [];
    }

    function verifyOptionInList(value, options) {
      if (!value || !options?.length) {
        throw new Error('verifyOptionInList: value and options are required');
      }
      const exact = options.find(o => o === value);
      if (!exact) {
        throw new Error(`Dropdown option not found in list: ${value}`);
      }
      return exact;
    }

    // Snap logical answers to exact dropdown option text (exact match → Claude pick).
    async function normalizeDropdownAnswers(entries) {
      const results = new Map();
      const needsLlm = [];

      for (const entry of entries) {
        const { key, el, label, answer } = entry;
        if (!answer || answer === 'N/A' || isDraftPlaceholderAnswer(answer)) {
          results.set(key, answer);
          continue;
        }
        if (!isDropdownField(el)) {
          results.set(key, answer);
          continue;
        }

        const options = await getFieldDropdownOptions(el);
        if (!options.length) {
          results.set(key, answer);
          continue;
        }

        const exact = options.find(o => o === answer)
          || options.find(o => o.toLowerCase() === String(answer).toLowerCase());
        if (exact) {
          results.set(key, exact);
          continue;
        }

        needsLlm.push({ key, label, answer, options });
      }

      if (needsLlm.length) {
        const llmPicks = await callClaudePickOptions(getApiKey(), needsLlm);
        for (const entry of needsLlm) {
          const picked = llmPicks[entry.label];
          if (!picked) {
            throw new Error(`Claude could not match dropdown option for "${entry.label}"`);
          }
          results.set(entry.key, verifyOptionInList(picked, entry.options));
        }
      }

      return results;
    }

    async function resolveExactDropdownValue(el, label, logicalAnswer) {
      if (!logicalAnswer || !isDropdownField(el)) return logicalAnswer;
      const normalized = await normalizeDropdownAnswers([{ key: label, el, label, answer: logicalAnswer }]);
      if (!normalized.has(label)) {
        throw new Error(`Dropdown normalization produced no value for "${label}"`);
      }
      return normalized.get(label);
    }

    async function fillDropdownField(el, label, logicalAnswer) {
      const exact = await resolveExactDropdownValue(el, label, logicalAnswer);
      return fillField(el, exact);
    }
  
    // Open THIS field's react-select menu and click the option matching `value`.
    // Options are scoped to the field (id^="react-select-<id>-option") so we never
    // click another question's option, and matching is exact → startsWith → whole
    // word (so "No" can't match "I am not a protected veteran"). Returns false and
    // closes the menu if nothing matches, rather than guessing.
    async function fillReactSelect(el, value) {
      const id = el.id || '';
      if (id === 'candidate-location') return fillGreenhouseLocation(el, value);
      if (isGreenhousePhoneCountry(el)) return fillGreenhousePhoneCountry(el, value);
  
      const searchText = value.trim();
      if (!searchText) return false;
  
      try {
        const result = await runGreenhouseReactSelectInPageContext(id, searchText);
        console.log('[DIAG-RS] react-select', { id, searchText, result });
        if (result.ok) return true;
        console.warn('[job-fill] fillReactSelect failed:', id, result);
        return false;
      } catch (e) {
        console.warn('[job-fill] fillReactSelect:', id, e);
        return false;
      }
    }
  
    // Generic (non-react-select) typeahead: wait up to ~1s for a visible exact-match
    // [role="option"] and click it.
    function pickDropdownOption(value) {
      const want = value.trim().toLowerCase();
      return new Promise(resolve => {
        const findAndClick = () => {
          const opts = Array.from(document.querySelectorAll('[role="option"]')).filter(o => {
            const r = o.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          const option = opts.find(o => o.textContent.trim().toLowerCase() === want);
          if (option) { option.click(); return true; }
          return false;
        };

        if (findAndClick()) { resolve(); return; }

        const timeout = setTimeout(() => { observer.disconnect(); resolve(); }, 1000);
        const observer = new MutationObserver(() => {
          if (findAndClick()) { clearTimeout(timeout); observer.disconnect(); resolve(); }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }

    async function copyTextToClipboard(text) {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable in this browser context');
      }
      await navigator.clipboard.writeText(text);
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
      let description = getJobDescriptionSync();
      if (!description) {
        description = await ensureJobDescription();
      }
      if (!description) {
        showToast('No job description found on this page');
        return;
      }
      const title = getJobTitle();
      const company = getCompanyName();
      const header = [title, company].filter(Boolean).join(' — ');
      const text = header ? `${header}\n\n${description}` : description;
      try {
        await copyTextToClipboard(text);
        showToast(`Copied ${text.length.toLocaleString()} chars  ✅`);
      } catch (e) {
        showToast(`Copy failed: ${e?.message || e}`);
      }
    }
  
    // Thrown by askUserModal when the user clicks ✕. runFill catches it to abort
    // the entire fill (instead of advancing to the next question).
    function fillCancelled() {
      const e = new Error('JAF_FILL_CANCELLED');
      e.jafCancelled = true;
      return e;
    }
  
    // ─── User prompt modal (replaces browser prompt()) ───────────────────────
    // Shows a styled overlay with the appropriate input control (text, select,
    // radio, or checkbox) matching the original field type. Resolves with the
    // answer string once the user clicks "Save & Fill"; REJECTS with a cancelled
    // marker (see fillCancelled) if the user clicks ✕, which aborts the whole fill.
    function askUserModal({ question, type = 'text', options = [] }) {
      return new Promise((resolve, reject) => {
        document.getElementById('jaf-ask-overlay')?.remove();
  
        // Spinner blocks the modal on host+worker setups — hide it while the user answers.
        if (getFrameRole() === 'worker') {
          window.parent.postMessage({ jaf: 'spinner-hide' }, '*');
        } else {
          hideSpinner();
        }
  
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
        const guardFocus = e => {
          if (nodeInOverlay(overlay, e.target) || nodeInOverlay(overlay, e.relatedTarget)) {
            e.stopPropagation();
          }
        };
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
  
        // Close (✕) button — top-right. Cancels the ENTIRE fill (not just this question).
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.title = 'Cancel filling';
        Object.assign(closeBtn.style, {
          position: 'absolute', top: '10px', right: '12px',
          width: '30px', height: '30px', padding: '0', lineHeight: '1',
          border: 'none', borderRadius: '50%', background: 'transparent',
          color: '#9a3412', fontSize: '20px', fontWeight: '700', cursor: 'pointer',
        });
        closeBtn.onmouseenter = () => { closeBtn.style.background = '#fde68a'; };
        closeBtn.onmouseleave = () => { closeBtn.style.background = 'transparent'; };
        closeBtn.onclick = () => { teardown(); reject(fillCancelled()); };
  
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
        hint.textContent = 'Answer will save to Knowledge Base — won\'t ask again for this question.';
        Object.assign(hint.style, { fontSize: '14px', color: '#78716c', lineHeight: '1.4' });
  
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
      return ensureJobDescription().then(jobDescription => new Promise((resolve, reject) => {
        const knowledge = buildFullKnowledge();
        const aiInstructionsBlock = buildAiInstructionsBlock();
        const resumeBlock = buildResumeContextBlock();
        const jobBlock = jobDescription
          ? `\nJob description (the specific role being applied to — use this to tailor open-ended answers):\n${jobDescription}\n`
          : '';
        const prompt = `You are filling out a job application for a candidate, using their knowledge notes below${jobDescription ? ' together with the job description for this specific role' : ''}${resumeBlock ? ' and their resume' : ''}.
  Return a JSON object whose keys are the field NUMBERS shown below (as strings, e.g. "1", "2") and whose values are the answer string to fill in.
  If you genuinely cannot determine an answer, set the value to null.
  
  Field labels (answer each one by its number):
  ${labels.map((l, i) => `${i + 1}. ${l}`).join('\n')}
  
  Knowledge notes:
  ${knowledge}
  ${resumeBlock}${jobBlock}${aiInstructionsBlock}
  Rules:
  - Base every factual answer on the knowledge notes and resume (when provided). You MAY logically derive an answer that the notes or resume unambiguously imply — e.g. infer the country (and broader region) from a stated city or state ("San Francisco, California" clearly implies the country is "United States"), infer the state from a well-known city, or give a yes/no that follows directly from the notes. Deriving an unambiguous fact like this is expected and is NOT fabrication.
  - Do NOT invent skills, years of experience, employers, education, credentials, or contact details (email, phone, exact address) that are neither stated nor unambiguously implied by the notes or resume.
  - For open-ended questions (why interested in this role/company, why you're a good fit, cover-letter style answers), tailor the response to the job description above and reference specifics from it — but ground every claim about the candidate's background in the knowledge notes and resume.
  - Write every answer in the FIRST PERSON, as the candidate speaking ("I", "my", "me"). Never refer to the candidate by name or in the third person — do not write "Sam", "he", "she", or "the candidate". E.g. write "I have used Tableau extensively…" not "Sam has used Tableau…".
  - For yes/no questions, answer only "Yes" or "No".
  - For numeric fields (years of experience, pay rate), give a single number.
  - For demographic self-identification (disability, veteran status, gender, race/ethnicity, sexual orientation), use the candidate's answer from the knowledge notes; if it is not present, return null.
  - Fields labeled "[Optional, if 'X' is selected above]" are conditional — if the stated condition was not met based on other answers (e.g. a non-'other' pronoun was already answered), return the string "N/A" so the field is not left blank.
  - If you cannot answer a field, return null for that number.
  - Follow any additional instructions from the candidate when they do not conflict with the rules above.
  - Respond ONLY with a valid JSON object keyed by field number. No markdown, no explanation.`;
  
        console.log('[DIAG-LLM] calling Claude', {
          frame: getFrameRole(),
          host: location.hostname,
          fields: labels.length,
          kbChars: knowledge.length,
          jobDescChars: jobDescription.length,
          aiInstructionChars: getAiInstructions().trim().length,
          resumeChars: (getResumeMeta().text || '').length,
          labels,
        });
        if (!knowledge.trim()) console.warn('[DIAG-LLM] Knowledge Base is EMPTY — answers will be generic/guessed.');
  
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
            console.log('[DIAG-LLM] HTTP status', res.status);
            try {
              const body = JSON.parse(res.responseText);
              if (body.error) {
                console.error('[DIAG-LLM] API error', body.error);
                reject(new Error('Claude API error: ' + (body.error.message || JSON.stringify(body.error))));
                return;
              }
              const text = body.content[0].text.trim();
              console.log('[DIAG-LLM] raw answer', text);
              const cleaned = text.startsWith('```')
                ? text.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim()
                : text;
              const answers = mapNumberedAnswers(JSON.parse(cleaned), labels);
              console.log('[DIAG-LLM] mapped answers', answers);
              resolve(answers);
            } catch (e) {
              console.error('[DIAG-LLM] parse failed', res.status, res.responseText.slice(0, 500));
              reject(new Error('Claude response parse failed: ' + res.responseText.slice(0, 200)));
            }
          },
          onerror(err) {
            console.error('[DIAG-LLM] request failed', err);
            reject(new Error('Request failed: ' + JSON.stringify(err)));
          },
        });
      }));
    }

    function mapNumberedPickAnswers(raw, picks) {
      const out = {};
      picks.forEach((p, i) => {
        const num = String(i + 1);
        let v = raw[num] ?? raw[p.label];
        if (v == null) {
          for (const [k, val] of Object.entries(raw)) {
            const stripped = k.replace(/^\d+\s*[.):\-]?\s*/, '').trim();
            if (k === num || stripped === p.label) { v = val; break; }
          }
        }
        if (v != null && String(v).trim() !== '') {
          out[p.label] = verifyOptionInList(String(v).trim(), p.options);
        }
      });
      return out;
    }

    function callClaudePickOptions(apiKey, picks) {
      return new Promise((resolve, reject) => {
        const aiInstructionsBlock = buildAiInstructionsBlock();
        const prompt = `You match intended answers to exact dropdown option text from job application forms.

For each numbered item below, the candidate's intended answer is given along with the EXACT list of dropdown options shown on the form. Pick the ONE option whose text best matches the intended answer.
${aiInstructionsBlock}
CRITICAL RULES:
- Your value MUST be copied CHARACTER-FOR-CHARACTER from the options list — exact spelling, punctuation, slashes, spaces, and capitalization.
- Do NOT paraphrase, abbreviate, or reformat. If the option is "he/him/his", return "he/him/his" not "He/Him".
- If the intended answer is a subset or synonym (e.g. "He/Him" for "he/him/his"), pick the matching full option text exactly as written in the list.
- If no option fits, return null for that number.

Items:
${picks.map((p, i) => `${i + 1}. Question: ${p.label}
   Intended answer: ${p.answer}
   Options: ${p.options.map((o, j) => `[${j + 1}] ${o}`).join(' | ')}`).join('\n\n')}

Respond ONLY with a JSON object keyed by item number (strings "1", "2", ...) with values being the exact option text or null. No markdown, no explanation.`;

        console.log('[DIAG-LLM] calling Claude option pick', { fields: picks.length, picks: picks.map(p => p.label) });

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
            max_tokens: 512,
            messages: [{ role: 'user', content: prompt }],
          }),
          onload(res) {
            try {
              const body = JSON.parse(res.responseText);
              if (body.error) {
                reject(new Error('Claude API error: ' + (body.error.message || JSON.stringify(body.error))));
                return;
              }
              const text = body.content[0].text.trim();
              const cleaned = text.startsWith('```')
                ? text.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim()
                : text;
              const answers = mapNumberedPickAnswers(JSON.parse(cleaned), picks);
              console.log('[DIAG-LLM] option picks', answers);
              resolve(answers);
            } catch (e) {
              reject(new Error('Claude option pick parse failed: ' + res.responseText.slice(0, 200)));
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
  
    // ─── Main fill logic ────────────────────────────────────────────────
    // Cached draft (from Preflight or prior fill) → fill from snapshot.
    // No draft → fill top-to-bottom one field at a time while building the draft;
    // Claude batch runs in parallel so direct/KB fields fill without waiting.
    async function runFill() {
      const btn = document.getElementById('jaf-fill-btn');
      const setLabel = (text) => { if (btn) btn.textContent = text; };
      const isWorker = getFrameRole() === 'worker';

      setLabel('Working…');
      if (isWorker) { window.parent.postMessage({ jaf: 'spinner-show' }, '*'); } else { showSpinner(); }

      try {
        const unfilled = collectFillableFields();
        console.log('[FILL] unfilled fields:', unfilled.length, unfilled.map(f => `[${f.type}] ${f.label}`));

        if (unfilled.length === 0) {
          showToast('No fillable fields found — scroll to the application form and try again.');
          setLabel('No fields found');
          setTimeout(() => setLabel('Fill Empty Fields'), 1500);
          return;
        }

        const fingerprint = computeFormFingerprint();
        const hasDraft = jafDraft && jafDraft.fingerprint === fingerprint;

        if (hasDraft) {
          console.log('[FILL] using cached draft');
          if (jafDraft.items.some(draftNeedsPrompt)) {
            setLabel('Need your input…');
            if (isWorker) window.parent.postMessage({ jaf: 'spinner-hide' }, '*');
            else hideSpinner();
            await resolveDraftPrompts(jafDraft);
            if (isWorker) window.parent.postMessage({ jaf: 'spinner-show' }, '*');
            else showSpinner();
          }
          setLabel('Filling…');
          await fillFromDraft(jafDraft);
          jafDraft.usedForFill = true;
        } else {
          console.log('[FILL] no draft — incremental fill + build draft');
          await runFillIncremental(isWorker, setLabel);
        }

      } catch (e) {
        if (e && e.jafCancelled) {
          setLabel('Cancelled');
          setTimeout(() => setLabel('Fill Empty Fields'), 1500);
        } else {
          console.error('[job-fill]', e);
          setLabel('Error — see console');
          setTimeout(() => setLabel('Fill Empty Fields'), 1500);
        }
      } finally {
        if (isWorker) { window.parent.postMessage({ jaf: 'spinner-hide' }, '*'); } else { hideSpinner(); }
        const keepLabel = btn && (
          btn.textContent === 'Error — see console' ||
          btn.textContent === 'Cancelled' ||
          btn.textContent === 'No fields found'
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

      const guardFocus = e => {
        if (nodeInOverlay(overlay, e.target) || nodeInOverlay(overlay, e.relatedTarget)) {
          e.stopPropagation();
        }
      };
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
        try {
          await copyTextToClipboard(textarea.value);
          showToast('Copied to clipboard');
        } catch (e) {
          showToast(`Copy failed: ${e?.message || e}`);
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
  
    // ─── Preflight overlay ───────────────────────────────────────────────────────
    let preflightRunId = 0;

    async function openPreflight() {
      const runId = ++preflightRunId;
      document.getElementById('jaf-preflight-overlay')?.remove();
      showSpinner();

      const SOURCE_LABELS = {
        current: 'already filled',
        direct: 'profile / direct map',
        kb: 'knowledge base',
        claude: 'claude',
        auto: 'auto',
        prompt: 'will ask',
        user: 'you (prompted)',
      };

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
        transition: 'transform 0.08s ease, box-shadow 0.08s ease',
      });
      xBtn.addEventListener('click', () => panel.remove());

      titleRow.appendChild(title);
      titleRow.appendChild(xBtn);

      const summary = document.createElement('div');
      summary.textContent = 'Scanning fields…';
      Object.assign(summary.style, { fontSize: '12px', color: '#78716c', lineHeight: '1.4' });

      const list = document.createElement('ol');
      Object.assign(list.style, {
        margin: '0', paddingLeft: '0', listStyle: 'none',
        display: 'flex', flexDirection: 'column', gap: '8px',
        overflowY: 'auto', maxHeight: 'calc(88vh - 110px)',
      });

      panel.appendChild(titleRow);
      panel.appendChild(summary);
      panel.appendChild(list);
      document.body.appendChild(panel);

      // Drag by the title row
      let pfDragging = false, pfStartX, pfStartY, pfStartRight, pfStartTop;
      titleRow.style.cursor = 'grab';
      titleRow.addEventListener('mousedown', e => {
        if (e.button !== 0 || xBtn.contains(e.target)) return;
        e.preventDefault();
        pfDragging = true;
        pfStartX = e.clientX; pfStartY = e.clientY;
        const rect = panel.getBoundingClientRect();
        pfStartRight = window.innerWidth - rect.right;
        pfStartTop = rect.top;
        panel.style.right = pfStartRight + 'px';
        panel.style.top = pfStartTop + 'px';
        titleRow.style.cursor = 'grabbing';
        const onMove = ev => {
          if (!pfDragging) return;
          panel.style.right = (pfStartRight - (ev.clientX - pfStartX)) + 'px';
          panel.style.top  = (pfStartTop  + (ev.clientY - pfStartY)) + 'px';
        };
        const onUp = () => {
          pfDragging = false;
          titleRow.style.cursor = 'grab';
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      const renderFields = (fields, meta = {}) => {
        list.textContent = '';
        const emptyCount = fields.filter(f => !f.filled).length;
        const resolvedCount = fields.filter(f => !f.filled && f.source !== 'prompt').length;
        const ageMin = meta.generatedAt ? Math.max(0, Math.round((Date.now() - meta.generatedAt) / 60000)) : 0;
        const ageStr = ageMin === 0 ? 'just now' : `${ageMin} min ago`;
        if (meta.cached && meta.usedForFill) {
          summary.textContent = `Snapshot from last fill · ${fields.length} fields · ${ageStr} · not regenerated`;
        } else if (meta.cached) {
          summary.textContent = `Cached draft · ${fields.length} fields · ${ageStr} · not regenerated`;
        } else {
          summary.textContent = `${fields.length} field${fields.length !== 1 ? 's' : ''} · ${emptyCount} to fill · ${resolvedCount} pre-resolved`;
        }

        fields.forEach((field, i) => {
          const item = document.createElement('li');
          Object.assign(item.style, {
            fontSize: '13px', lineHeight: '1.45',
            padding: '10px 12px', borderRadius: '8px',
            background: field.filled ? '#f5f5f4' : '#fef3c7',
            border: field.filled ? '1px solid #e7e5e4' : '1px solid #fde68a',
            display: 'flex', flexDirection: 'column', gap: '6px',
            color: '#1c1917',
          });

          const topRow = document.createElement('div');
          Object.assign(topRow.style, {
            display: 'flex', alignItems: 'flex-start', gap: '8px',
          });

          const numSpan = document.createElement('span');
          numSpan.textContent = (i + 1) + '.';
          Object.assign(numSpan.style, {
            minWidth: '24px', flexShrink: '0', textAlign: 'right',
            color: '#9a3412', fontWeight: '700', fontSize: '12px', paddingTop: '1px',
          });

          const questionSpan = document.createElement('span');
          questionSpan.textContent = field.label;
          Object.assign(questionSpan.style, {
            flex: '1', fontWeight: '600', color: field.filled ? '#57534e' : '#1c1917',
            wordBreak: 'break-word',
          });
          if (field.filled) questionSpan.style.textDecoration = 'line-through';

          const statusSpan = document.createElement('span');
          statusSpan.textContent = field.filled ? '✓ filled' : '○ empty';
          Object.assign(statusSpan.style, {
            flexShrink: '0', fontSize: '11px', fontWeight: '700',
            color: field.filled ? '#16a34a' : '#d97706',
            paddingTop: '2px',
          });

          topRow.appendChild(numSpan);
          topRow.appendChild(questionSpan);
          topRow.appendChild(statusSpan);

          const answerRow = document.createElement('div');
          Object.assign(answerRow.style, {
            display: 'flex', alignItems: 'baseline', gap: '8px',
            marginLeft: '32px', paddingLeft: '10px',
            borderLeft: '3px solid ' + (field.filled ? '#a8a29e' : '#f59e0b'),
          });

          const answerLabel = document.createElement('span');
          answerLabel.textContent = '→';
          Object.assign(answerLabel.style, {
            flexShrink: '0', color: '#b45309', fontWeight: '700', fontSize: '14px',
          });

          const answerText = document.createElement('span');
          const preflightAnswerText = (
            /by checking this box/i.test(String(field.label || '')) &&
            field.answer &&
            !isDraftPlaceholderAnswer(field.answer)
          )
            ? '✔️'
            : (field.answer || '(no answer)');
          answerText.textContent = preflightAnswerText;
          Object.assign(answerText.style, {
            flex: '1', color: field.source === 'prompt' ? '#b45309' : '#15803d',
            fontWeight: '500', wordBreak: 'break-word', whiteSpace: 'pre-wrap',
          });

          const sourceTag = document.createElement('span');
          sourceTag.textContent = SOURCE_LABELS[field.source] || field.source;
          Object.assign(sourceTag.style, {
            flexShrink: '0', fontSize: '10px', fontWeight: '600',
            color: '#78716c', background: '#fff', border: '1px solid #e7e5e4',
            borderRadius: '4px', padding: '2px 6px', textTransform: 'uppercase',
            letterSpacing: '0.03em',
          });

          answerRow.appendChild(answerLabel);
          answerRow.appendChild(answerText);
          answerRow.appendChild(sourceTag);

          item.appendChild(topRow);
          item.appendChild(answerRow);
          list.appendChild(item);
        });

        if (fields.length === 0) {
          const empty = document.createElement('div');
          empty.textContent = 'No fillable fields detected on this page.';
          Object.assign(empty.style, { fontSize: '13px', color: '#78716c', padding: '8px 0' });
          list.appendChild(empty);
        }
      };

      // Reuse cached draft when valid — including the exact snapshot used for a prior fill.
      let fields;
      let meta = {};
      try {
        if (getFrameRole() === 'host') {
          const targets = getAtsWorkerIframes();
          const targetWins = new Set(
            targets.map(f => { try { return f.contentWindow; } catch (_) { return null; } }).filter(Boolean)
          );
          const result = await new Promise(resolve => {
            const onMsg = e => {
              if (!e.data || e.data.jaf !== 'preflight-result') return;
              if (!targetWins.has(e.source)) return;
              // Ignore empty/incomplete replies while the worker is still building the draft.
              if (!e.data.complete) return;
              window.removeEventListener('message', onMsg);
              clearTimeout(timer);
              resolve(e.data);
            };
            window.addEventListener('message', onMsg);
            const timer = setTimeout(() => {
              window.removeEventListener('message', onMsg);
              resolve({ timedOut: true });
            }, 300000);
            targets.forEach(f => { try { f.contentWindow.postMessage({ jaf: 'preflight' }, '*'); } catch (_) {} });
          });
          if (runId !== preflightRunId) return;
          if (result.timedOut) {
            summary.textContent = 'Scan timed out — try Preflight again (large forms can take a few minutes).';
            list.textContent = '';
            return;
          }
          if (result.error) {
            summary.textContent = `Preflight failed: ${result.error}`;
            list.textContent = '';
            return;
          }
          fields = result.fields || [];
          meta = {
            cached: !!result.cached,
            usedForFill: !!result.usedForFill,
            generatedAt: result.generatedAt || Date.now(),
          };
        } else {
          const fp = computeFormFingerprint();
          if (jafDraft && jafDraft.fingerprint === fp) {
            fields = jafDraft.items;
            meta = { cached: true, usedForFill: jafDraft.usedForFill, generatedAt: jafDraft.generatedAt };
          } else {
            const draft = await ensureDraft(false);
            fields = draft.items;
            meta = { cached: false, usedForFill: draft.usedForFill, generatedAt: draft.generatedAt };
          }
        }

        if (runId !== preflightRunId) return;
        renderFields(fields, meta);
      } catch (e) {
        console.error('[preflight]', e);
        if (runId === preflightRunId) showToast('Preflight failed — see console');
      } finally {
        if (runId === preflightRunId) hideSpinner();
      }
    }

    // ─── Frame role ─────────────────────────────────────────────────────────────
    // The script loads in every frame on every site (@match *://*/*) so it can catch
    // Greenhouse application forms wherever they live. A page can present the form in
    // two layouts, and the widget has to behave differently for each:
    //
    //   • STANDALONE — form + page are the same document (greenhouse.io opened
    //     directly, LinkedIn jobs, a company page rendering the app inline). One
    //     widget does everything: its position:fixed buttons float against the
    //     viewport and it fills the form in its own DOM.
    //
    //   • HOST + WORKER — the form is a cross-origin <iframe> embedded in a company
    //     page (e.g. asana.com embeds a greenhouse.io "Greenhouse Job Board" iframe,
    //     sized to its full content height with scrolling="no", so the PARENT page
    //     scrolls). Two problems: the top frame can't touch the iframe's fields, and
    //     position:fixed INSIDE the iframe pins to the oversized iframe box, so it
    //     scrolls off-screen. Fix: the top frame is the HOST — it shows the floating
    //     UI (correctly pinned to the real viewport) and relays a fill request via
    //     postMessage; the iframe is a headless WORKER that fills when asked.
    //
    const ATS_KNOWN_HOSTS = [
      'greenhouse.io', 'lever.co', 'ashbyhq.com', 'gem.com', 'recruitee.com', 'breezy.hr',
      'applytojob.com', 'rippling.com', 'myworkdayjobs.com', 'workable.com', 'smartrecruiters.com',
      'jobvite.com', 'icims.com', 'taleo.net', 'bamboohr.com', 'jazz.co', 'paylocity.com',
    ];

    function isKnownAtsHost(hostname) {
      const host = (hostname || '').toLowerCase();
      return ATS_KNOWN_HOSTS.some(h => host === h || host.endsWith('.' + h));
    }

    function isJobApplicationUrlStrong(url = location.href) {
      const u = new URL(url, location.href);
      const host = u.hostname.toLowerCase();
      const path = u.pathname.toLowerCase();
      const search = u.search.toLowerCase();
      if (/\/apply\b|\/application\b/.test(path)) return true;
      // Native company career listings (e.g. stripe.com/jobs/listing/.../7747640)
      if (/\/jobs\/listing\b/.test(path)) return true;
      if (/\/careers\/listing\b/.test(path)) return true;
      if (host.startsWith('ats.') || host.includes('.ats.') || host.split('.').includes('ats')) return true;
      if (isKnownAtsHost(host) && /\/jobs?\//.test(path)) return true;
      if (/[?&](gh_jid|gh_src|ashby_jid|jobid|job_id|jobId)=/.test(search) && /\/jobs?\//.test(path)) return true;
      return false;
    }

    function hasResumeUploadField(doc = document) {
      for (const el of doc.querySelectorAll('input[type="file"]')) {
        const labelledBy = el.getAttribute('aria-labelledby');
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        const idName = `${el.id || ''} ${el.name || ''}`.toLowerCase();
        let labelText = ariaLabel;
        if (labelledBy) {
          const lbl = doc.getElementById(labelledBy);
          if (lbl) labelText = (lbl.textContent || '').toLowerCase();
        }
        const group = el.closest('[role="group"][aria-labelledby]');
        if (group) {
          const gid = group.getAttribute('aria-labelledby');
          const glbl = gid && doc.getElementById(gid);
          if (glbl) labelText = (glbl.textContent || '').toLowerCase();
        }
        const combined = `${labelText} ${idName}`;
        if (/resume|résumé|curriculum vitae|\bcv\b/.test(combined)) return true;
      }
      return false;
    }

    function scoreJobApplicationPage(doc = document) {
      let score = 0;
      const host = location.hostname.toLowerCase();
      const path = location.pathname.toLowerCase();

      if (isKnownAtsHost(host)) score += 5;
      if (isJobApplicationUrlStrong()) score += 5;
      if (hasAshbyJobMarker()) score += 4;
      if (/\/jobs?\//.test(path)) score += 2;
      if (hasInlineApplicationForm()) score += 3;
      if (hasResumeUploadField(doc)) score += 4;

      const hasFirst = !!doc.querySelector(
        '#first_name, input[name="first_name"], input[autocomplete="given-name"]',
      );
      const hasLast = !!doc.querySelector(
        '#last_name, input[name="last_name"], input[autocomplete="family-name"]',
      );
      const hasEmail = !!doc.querySelector(
        'input[type="email"], input[name="email"], input[autocomplete="email"]',
      );
      if (hasFirst && hasEmail) score += 3;
      if (hasFirst && hasLast && hasEmail) score += 2;

      const hasPhone = !!doc.querySelector(
        'input[type="tel"], input[name="phone"], input[autocomplete="tel"]',
      );
      if (hasPhone && hasEmail) score += 1;

      const heading = doc.querySelector('h1, h2, [role="heading"]');
      const headingText = (heading?.textContent || '').toLowerCase();
      if (/application|apply for|job application/.test(headingText)) score += 2;
      if (/application|apply/i.test(document.title || '')) score += 1;

      if (/login|signin|sign-in|checkout|cart|newsletter|subscribe|password-reset/.test(path)) score -= 5;
      if (doc.querySelector('input[type="password"]') && !hasEmail) score -= 4;

      return score;
    }

    // Career-site job detail pages (e.g. Talemetry/Jobvite on careers.qcells.com) — JD
    // is on-page but there is no inline apply form until the user clicks Apply.
    function isJobDescriptionPage(doc = document) {
      const path = location.pathname.toLowerCase();
      if (!/\/jobs\/[^/?#]+/.test(path)) return false;
      if (/\/jobs\/(search|list|listing|all)(\/|$)/.test(path)) return false;
      if (scrapeJobDescriptionFromDocument(doc).length <= 100) return false;
      const title = (doc.querySelector('h1')?.textContent || '').trim();
      return title.length >= 2 && title.length <= 200;
    }

    function isJobApplicationPage(doc = document) {
      if (isJobApplicationUrlStrong()) return true;
      if (isJobDescriptionPage(doc)) return true;
      return scoreJobApplicationPage(doc) >= 6;
    }

    function isJobApplicationEmbedIframe(iframe) {
      if (isGreenhouseEmbedIframe(iframe) || isAshbyEmbedIframe(iframe)) return true;
      const src = iframe.getAttribute('src') || '';
      if (!src.trim()) return false;
      const u = new URL(src, location.href);
      if (isJobApplicationUrlStrong(u.href)) return true;
      const h = u.hostname.toLowerCase();
      if (isKnownAtsHost(h)) return true;
      if (/\bats\.|myworkdayjobs|recruiting\.|careers\./.test(h)) return true;
      return /\/apply\b|\/application\b/.test(u.pathname.toLowerCase());
    }

    function getJobApplicationWorkerIframes() {
      const out = new Set();
      for (const el of document.querySelectorAll('iframe')) {
        if (isJobApplicationEmbedIframe(el)) out.add(el);
      }
      return [...out];
    }

    // Ashby custom careers pages (e.g. elevenlabs.io/careers/{jid}/...?ashby_jid=...)
    function hasAshbyJobMarker() {
      if (/[?&]ashby_jid=/.test(location.search)) return true;
      return /\/careers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(location.pathname);
    }

    function hasInlineApplicationForm() {
      return !!(
        document.querySelector('#application-form, form.application--form, .application--form') ||
        document.querySelector('#first_name, input[name="first_name"]') ||
        document.querySelector('[class*="ashby" i] form, [id*="ashby" i] form, form[class*="Application" i]')
      );
    }

    async function waitForInlineApplicationForm(maxMs = 20000) {
      if (hasInlineApplicationForm()) return true;
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        await sleep(200);
        if (hasInlineApplicationForm()) return true;
      }
      return hasInlineApplicationForm();
    }

    function postPreflightResultToHost(payload) {
      window.parent.postMessage({ jaf: 'preflight-result', complete: true, ...payload }, '*');
    }

    // Only real Greenhouse embed iframes — not unrelated iframes whose src merely
    // contains "greenhouse" (e.g. Google API proxy #parent=…job-boards.greenhouse.io).
    function isGreenhouseEmbedIframe(iframe) {
      const src = iframe.getAttribute('src') || '';
      if (!src.trim()) return false;
      const h = new URL(src, location.href).hostname.toLowerCase();
      return h === 'greenhouse.io' || h.endsWith('.greenhouse.io');
    }

    function isAshbyEmbedIframe(iframe) {
      const src = iframe.getAttribute('src') || '';
      if (!src.trim()) return false;
      const h = new URL(src, location.href).hostname.toLowerCase();
      return h === 'ashbyhq.com' || h.endsWith('.ashbyhq.com');
    }

    function getGreenhouseWorkerIframes() {
      const out = new Set();
      for (const el of document.querySelectorAll('#grnhse_iframe, #grnhse_app iframe')) {
        out.add(el);
      }
      for (const el of document.querySelectorAll('iframe[title*="Greenhouse" i]')) {
        if (isGreenhouseEmbedIframe(el)) out.add(el);
      }
      for (const el of document.querySelectorAll('iframe')) {
        if (isGreenhouseEmbedIframe(el)) out.add(el);
      }
      return [...out];
    }

    function getAshbyWorkerIframes() {
      const out = new Set();
      for (const el of document.querySelectorAll('iframe[title*="Ashby" i], iframe[id*="ashby" i]')) {
        if (isAshbyEmbedIframe(el)) out.add(el);
      }
      for (const el of document.querySelectorAll('iframe')) {
        if (isAshbyEmbedIframe(el)) out.add(el);
      }
      return [...out];
    }

    function getAtsWorkerIframes() {
      const out = new Set([
        ...getGreenhouseWorkerIframes(),
        ...getAshbyWorkerIframes(),
        ...getJobApplicationWorkerIframes(),
      ]);
      return [...out];
    }

    function isCompanyGreenhouseEmbedPage() {
      if (window.self !== window.top || hasInlineApplicationForm()) return false;
      if (isKnownAtsHost(location.hostname)) return false;
      return /[?&]gh_jid=/.test(location.search) || /[?&]gh_src=/.test(location.search);
    }

    function isCompanyAshbyEmbedPage() {
      if (window.self !== window.top || hasInlineApplicationForm()) return false;
      if (isKnownAtsHost(location.hostname)) return false;
      return hasAshbyJobMarker();
    }

    function shouldUseHostWorkerRelay() {
      if (hasInlineApplicationForm()) return false;
      if (document.querySelector('#grnhse_app, #grnhse_iframe')) return true;
      if (getAtsWorkerIframes().length > 0) return true;
      // vestfin.com, asana.com, etc. — GH form is in a lazy-loaded embed iframe.
      return isCompanyGreenhouseEmbedPage() || isCompanyAshbyEmbedPage();
    }

    // Returns 'standalone' | 'host' | 'worker' | 'none'.
    function getFrameRole() {
      const host = location.hostname;
      const inFrame = window.self !== window.top;
      const isKnown = isKnownAtsHost(host);
      const isLinkedInJob = (host === 'linkedin.com' || host.endsWith('.linkedin.com')) && location.pathname.startsWith('/jobs/');
  
      // ATS form rendered inside a cross-origin embed iframe → headless worker.
      if (inFrame && (isKnown || isJobApplicationUrlStrong() || isJobApplicationPage())) return 'worker';
      // Company page (e.g. asana.com, elevenlabs.io) with GH/Ashby embed — not inline apply on parent.
      if (!inFrame && shouldUseHostWorkerRelay()) return 'host';
      // Form and UI share one document.
      if (isKnown || isLinkedInJob) return 'standalone';
      if ((/[?&]gh_jid=/.test(location.search) || /[?&]gh_src=/.test(location.search)) && hasInlineApplicationForm()) {
        return 'standalone';
      }
      if (hasAshbyJobMarker() && hasInlineApplicationForm()) return 'standalone';
      if (!inFrame && hasAshbyJobMarker() && !isKnown) return 'standalone';
      if (location.hash.includes('grnhse_app')) return 'standalone';
      if (!inFrame && !hasInlineApplicationForm() && getJobApplicationWorkerIframes().length > 0) return 'host';
      if (isJobApplicationPage()) return 'standalone';
      return 'none';
    }

    async function waitForAtsWorkerIframes(maxMs = 20000) {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        const targets = getAtsWorkerIframes();
        if (targets.length) return targets;
        await sleep(250);
      }
      return getAtsWorkerIframes();
    }
  
    // Host → worker: ask the embedded ATS iframe(s) to fill themselves.
    async function requestFillFromWorker() {
      showToast('Filling the application form…');
      let targets = getAtsWorkerIframes();
      if (!targets.length) targets = await waitForAtsWorkerIframes(20000);
      if (!targets.length) {
        showToast('Application form not found — open the job application, then try Fill again.');
        return;
      }
      targets.forEach(f => { try { f.contentWindow.postMessage({ jaf: 'fill' }, '*'); } catch (e) {} });
    }
  
    // ─── Floating widget ──────────────────────────────────────────────────────
    const JAF_WIDGET_VERSION = '12'; // bump when widget buttons/layout change
    let widgetDismissed = false;

    function dismissWidget(widget) {
      widgetDismissed = true;
      widget.remove();
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
      const role = getFrameRole();
      // Worker frames stay headless (they fill on postMessage); 'none' = unrelated page.
      if (role === 'worker' || role === 'none') return;
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
        left: role === 'host' ? '0' : '60px',
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
      // Host relays to the worker iframe; standalone fills its own document.
      fillBtn.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        const liveRole = getFrameRole();
        if (liveRole === 'host') requestFillFromWorker();
        else runFill();
      });

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
  
    // ─── Init ─────────────────────────────────────────────────────────────────
    if (getFrameRole() === 'worker') {
      // Headless worker: no visible UI. Fill only when the host (parent) frame asks.
      window.addEventListener('message', e => {
        if (!e.data || e.source !== window.parent) return;
        if (e.data.jaf === 'fill') runFill();
        if (e.data.jaf === 'preflight') {
          (async () => {
            await waitForInlineApplicationForm();
            const fp = computeFormFingerprint();
            if (jafDraft && jafDraft.fingerprint === fp) {
              postPreflightResultToHost({
                fields: jafDraft.items,
                cached: true,
                usedForFill: jafDraft.usedForFill,
                generatedAt: jafDraft.generatedAt,
              });
            } else {
              const draft = await ensureDraft(false);
              postPreflightResultToHost({
                fields: draft.items,
                cached: false,
                usedForFill: draft.usedForFill,
                generatedAt: draft.generatedAt,
              });
            }
          })().catch(err => {
            console.error('[preflight] worker', err);
            postPreflightResultToHost({ fields: [], complete: true, error: String(err?.message || err) });
          });
        }
      });
    } else {
      // Host/standalone: relay spinner messages from the worker iframe so the spinner
      // appears in the real viewport (top frame) rather than inside the scrollable iframe.
      window.addEventListener('message', e => {
        if (!e.data) return;
        if (e.data.jaf === 'spinner-show') showSpinner();
        else if (e.data.jaf === 'spinner-hide') hideSpinner();
      });
      if (document.body) {
        injectWidget();
        scheduleWidgetCheck();
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          injectWidget();
          scheduleWidgetCheck();
        });
      }
    }
  
    // Re-inject when SPA navigation or React hydration mutates the DOM.
    // Observe documentElement + subtree — body-only observers miss Greenhouse hydration
    // (job-boards.greenhouse.io wipes direct body children without firing on body).
    let widgetInjectDebounce = null;
    function scheduleWidgetCheck() {
      clearTimeout(widgetInjectDebounce);
      widgetInjectDebounce = setTimeout(() => {
        if (!widgetDismissed && !document.getElementById('jaf-widget') && getFrameRole() !== 'worker') {
          injectWidget();
        }
        tryCacheAshbyJobDescriptionFromDom();
      }, 250);
    }

    function watchWidgetReinject() {
      const root = document.documentElement;
      if (!root) return;
      const observer = new MutationObserver(() => {
        scheduleWidgetCheck();
      });
      observer.observe(root, { childList: true, subtree: true });
    }

    watchWidgetReinject();
  
  })();