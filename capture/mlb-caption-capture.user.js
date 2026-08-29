// ==UserScript==
// @name         MLB Gameday Caption Capture
// @namespace    henry-english-app
// @version      0.3
// @description  Extract English captions and show a live transcript+translation panel on the MLB Gameday video page
// @match        https://www.mlb.com/gameday/*
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
  'use strict';

  function cleanCueText(text) {
    return text.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function findPlayingVideo() {
    const videos = [...document.querySelectorAll('video')];
    return videos.find(v => v.textTracks && v.textTracks.length > 0 && v.textTracks[0].cues && v.textTracks[0].cues.length > 0);
  }

  function getRawCues(video) {
    const track = video.textTracks[0];
    return [...track.cues].map(c => ({
      start: c.startTime,
      end: c.endTime,
      text: cleanCueText(c.text),
    })).filter(c => c.text.length > 0);
  }

  function groupCuesIntoSentences(cues) {
    const groups = [];
    let current = null;
    cues.forEach(cue => {
      const text = cue.text.trim();
      if (!text) return;
      if (!current) {
        current = { start: cue.start, end: cue.end, text };
      } else {
        current.end = cue.end;
        current.text += ' ' + text;
      }
      if (/[.!?]["')\]]?$/.test(text)) {
        groups.push(current);
        current = null;
      }
    });
    if (current) groups.push(current);
    return groups;
  }

  function getPermalink() {
    const shareBtn = [...document.querySelectorAll('button')].find(b =>
      b.getAttribute('aria-label') === 'Share' || b.textContent.trim() === 'Share' || b.title === 'Share'
    );
    if (!shareBtn) return null;

    const originalShare = navigator.share ? navigator.share.bind(navigator) : null;
    let captured = null;
    navigator.share = function (data) {
      captured = data;
      return Promise.resolve();
    };
    try {
      shareBtn.click();
    } catch (e) {
      // ignore
    }
    if (originalShare) {
      navigator.share = originalShare;
    } else {
      delete navigator.share;
    }
    return captured && captured.url ? captured.url : null;
  }

  function guessTitleAndDescription(video) {
    const rect = video.getBoundingClientRect();
    const candidates = [...document.querySelectorAll('h1, h2, h3, strong, b, p')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        const text = el.textContent.trim();
        return text.length > 5 && text.length < 400 && r.top >= rect.bottom && r.top - rect.bottom < 400;
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

    const title = candidates[0]?.textContent.trim() || document.title;
    const description = candidates.slice(1).map(el => el.textContent.trim()).find(t => t !== title) || '';
    return { title, description };
  }

  function extractClip() {
    const video = findPlayingVideo();
    if (!video) {
      alert('字幕トラック付きの動画が見つかりません。クリップを再生してから数秒待って、もう一度お試しください。');
      return null;
    }

    const cues = getRawCues(video);
    const { title, description } = guessTitleAndDescription(video);
    const permalink = getPermalink();

    return {
      capturedAt: new Date().toISOString(),
      pageUrl: permalink || location.href,
      title,
      description,
      cueCount: cues.length,
      cues,
    };
  }

  function showPreview(clip) {
    const preview = [
      `タイトル: ${clip.title}`,
      `説明: ${clip.description || '(検出できず)'}`,
      `字幕行数: ${clip.cueCount}`,
      '',
      '--- 最初の3行 ---',
      ...clip.cues.slice(0, 3).map(c => `[${c.start}s] ${c.text}`),
    ].join('\n');

    const ok = confirm(preview + '\n\n この内容でクリップボードにJSONをコピーしますか？（タイトルが違う場合は後で編集してください）');
    if (ok) {
      const json = JSON.stringify(clip, null, 2);
      GM_setClipboard(json);
      console.log('[MLB Caption Capture]', clip);
      alert('コピーしました。アプリ側に貼り付けてください。');
    }
  }

  // ---------- Gemini translation ----------
  function getGeminiKey() {
    let key = GM_getValue('geminiKey', '');
    if (!key) {
      key = prompt('Gemini APIキーを入力してください（初回のみ、この端末に保存されます）:');
      if (key) GM_setValue('geminiKey', key.trim());
    }
    return key;
  }

  async function translateSentences(sentences) {
    const key = getGeminiKey();
    if (!key) throw new Error('Gemini APIキーが未設定です。');
    const model = 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(sentences.map(s => s.text)) }] }],
      systemInstruction: {
        parts: [{
          text: 'あなたは野球実況の翻訳者です。次のJSON配列に含まれる英語の実況文を、自然な日本語に順番通り翻訳してください。出力は同じ要素数のJSON配列のみを返してください（説明文やコードブロック記号は一切不要）。各要素は日本語訳の文字列のみとしてください。',
        }],
      },
      generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('翻訳APIエラー: ' + res.status);
    const data = await res.json();
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    text = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
    return JSON.parse(text);
  }

  // ---------- Live transcript panel ----------
  let panelSentences = [];
  let panelTranslations = null;
  let panelVideo = null;
  let panelActiveIndex = -1;

  function buildPanel() {
    if (document.getElementById('mlb-caption-panel')) return document.getElementById('mlb-caption-panel');

    const panel = document.createElement('div');
    panel.id = 'mlb-caption-panel';
    Object.assign(panel.style, {
      position: 'fixed',
      top: '0',
      right: '0',
      width: '340px',
      height: '100vh',
      background: 'white',
      borderLeft: '2px solid #002d72',
      boxShadow: '-2px 0 12px rgba(0,0,0,0.2)',
      zIndex: '999998',
      display: 'none',
      flexDirection: 'column',
      fontFamily: 'sans-serif',
    });

    panel.innerHTML = `
      <div style="padding:10px; background:#002d72; color:white; display:flex; justify-content:space-between; align-items:center;">
        <strong style="font-size:14px;">字幕パネル</strong>
        <button id="mlb-panel-close" style="background:none;border:none;color:white;font-size:16px;cursor:pointer;">×</button>
      </div>
      <div style="padding:8px 10px; border-bottom:1px solid #ddd; display:flex; gap:8px; align-items:center;">
        <label style="font-size:12px; display:flex; align-items:center; gap:4px;">
          <input type="checkbox" id="mlb-panel-translate"> 和訳を表示
        </label>
        <button id="mlb-panel-refresh" style="font-size:11px; padding:3px 8px; cursor:pointer;">更新</button>
      </div>
      <div id="mlb-panel-list" style="flex:1; overflow-y:auto; padding:8px;"></div>
    `;
    document.body.appendChild(panel);

    document.getElementById('mlb-panel-close').addEventListener('click', () => {
      panel.style.display = 'none';
    });
    document.getElementById('mlb-panel-translate').addEventListener('change', async (e) => {
      if (e.target.checked && !panelTranslations) {
        const listEl = document.getElementById('mlb-panel-list');
        listEl.dataset.loading = '1';
        try {
          panelTranslations = await translateSentences(panelSentences);
        } catch (err) {
          alert('翻訳に失敗しました: ' + err.message);
          e.target.checked = false;
        }
        renderPanelList();
      } else {
        renderPanelList();
      }
    });
    document.getElementById('mlb-panel-refresh').addEventListener('click', () => {
      loadPanelFromCurrentVideo(true);
    });

    return panel;
  }

  function renderPanelList() {
    const listEl = document.getElementById('mlb-panel-list');
    if (!listEl) return;
    const showTranslation = document.getElementById('mlb-panel-translate').checked;
    listEl.innerHTML = panelSentences.map((s, i) => {
      const translation = showTranslation && panelTranslations ? panelTranslations[i] : null;
      return `
        <div class="mlb-panel-row" data-i="${i}" style="padding:8px; margin-bottom:6px; border-radius:6px; background:${i === panelActiveIndex ? '#fff3cd' : '#f7f7f8'}; cursor:pointer;">
          <div style="font-size:10px; color:#888;">${formatTime(s.start)}</div>
          <div style="font-size:13px;">${escapeHtml(s.text)}</div>
          ${translation ? `<div style="font-size:12px; color:#666; margin-top:3px;">${escapeHtml(translation)}</div>` : ''}
        </div>`;
    }).join('');

    listEl.querySelectorAll('.mlb-panel-row').forEach(row => {
      row.addEventListener('click', () => {
        const i = Number(row.dataset.i);
        if (panelVideo) panelVideo.currentTime = panelSentences[i].start;
      });
    });
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function onTimeUpdate() {
    if (!panelVideo) return;
    const t = panelVideo.currentTime;
    const idx = panelSentences.findIndex((s, i) => {
      const next = panelSentences[i + 1];
      return t >= s.start && (!next || t < next.start);
    });
    if (idx !== panelActiveIndex) {
      panelActiveIndex = idx;
      renderPanelList();
      const activeRow = document.querySelector(`.mlb-panel-row[data-i="${idx}"]`);
      if (activeRow) activeRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function loadPanelFromCurrentVideo(forceReset) {
    const video = findPlayingVideo();
    if (!video) {
      alert('字幕トラック付きの動画が見つかりません。再生してから数秒待ってお試しください。');
      return;
    }
    if (panelVideo && panelVideo !== video) {
      panelVideo.removeEventListener('timeupdate', onTimeUpdate);
    }
    if (forceReset || panelVideo !== video) {
      panelTranslations = null;
      panelActiveIndex = -1;
      const cbox = document.getElementById('mlb-panel-translate');
      if (cbox) cbox.checked = false;
    }
    panelVideo = video;
    panelVideo.addEventListener('timeupdate', onTimeUpdate);
    panelSentences = groupCuesIntoSentences(getRawCues(video));

    const panel = buildPanel();
    panel.style.display = 'flex';
    renderPanelList();
  }

  function addButtons() {
    if (!document.getElementById('mlb-caption-capture-btn')) {
      const btn = document.createElement('button');
      btn.id = 'mlb-caption-capture-btn';
      btn.textContent = '字幕を抽出';
      Object.assign(btn.style, {
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        zIndex: '999999',
        padding: '10px 16px',
        background: '#002d72',
        color: 'white',
        border: 'none',
        borderRadius: '6px',
        fontSize: '14px',
        cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      });
      btn.addEventListener('click', () => {
        const clip = extractClip();
        if (clip) showPreview(clip);
      });
      document.body.appendChild(btn);
    }

    if (!document.getElementById('mlb-panel-toggle-btn')) {
      const btn = document.createElement('button');
      btn.id = 'mlb-panel-toggle-btn';
      btn.textContent = '字幕パネル';
      Object.assign(btn.style, {
        position: 'fixed',
        bottom: '20px',
        right: '110px',
        zIndex: '999999',
        padding: '10px 16px',
        background: '#ff5910',
        color: 'white',
        border: 'none',
        borderRadius: '6px',
        fontSize: '14px',
        cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      });
      btn.addEventListener('click', () => {
        const panel = document.getElementById('mlb-caption-panel');
        if (panel && panel.style.display === 'flex') {
          panel.style.display = 'none';
        } else {
          loadPanelFromCurrentVideo(false);
        }
      });
      document.body.appendChild(btn);
    }
  }

  addButtons();
  setInterval(addButtons, 2000);
})();
