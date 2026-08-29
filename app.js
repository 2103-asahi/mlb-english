const STORAGE_CLIPS = 'mlbenglish_clips';
const STORAGE_CARDS = 'mlbenglish_cards';
const STORAGE_GEMINI_KEY = 'mlbenglish_gemini_key';
const STORAGE_SUPABASE_URL = 'mlbenglish_supabase_url';
const STORAGE_SUPABASE_KEY = 'mlbenglish_supabase_key';

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadClips() {
  return JSON.parse(localStorage.getItem(STORAGE_CLIPS) || '[]');
}
function saveClips(clips) {
  localStorage.setItem(STORAGE_CLIPS, JSON.stringify(clips));
}
function loadCards() {
  return JSON.parse(localStorage.getItem(STORAGE_CARDS) || '[]');
}
function saveCards(cards) {
  localStorage.setItem(STORAGE_CARDS, JSON.stringify(cards));
}

// ---------- Supabase sync ----------
let supabaseClient = null;

function loadSupabaseConfig() {
  return {
    url: localStorage.getItem(STORAGE_SUPABASE_URL) || '',
    key: localStorage.getItem(STORAGE_SUPABASE_KEY) || '',
  };
}
function saveSupabaseConfig(url, key) {
  localStorage.setItem(STORAGE_SUPABASE_URL, url);
  localStorage.setItem(STORAGE_SUPABASE_KEY, key);
  supabaseClient = null;
}

function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;
  const { url, key } = loadSupabaseConfig();
  if (!url || !key || typeof supabase === 'undefined') return null;
  supabaseClient = supabase.createClient(url, key);
  return supabaseClient;
}

function clipToRow(clip) {
  return {
    id: clip.id,
    captured_at: clip.capturedAt,
    page_url: clip.pageUrl,
    title: clip.title,
    description: clip.description,
    cues: clip.cues,
    updated_at: clip.updatedAt || new Date().toISOString(),
  };
}
function rowToClip(row) {
  return {
    id: row.id,
    capturedAt: row.captured_at,
    pageUrl: row.page_url,
    title: row.title,
    description: row.description,
    cues: row.cues,
    updatedAt: row.updated_at,
  };
}
function cardToRow(card) {
  return {
    id: card.id,
    clip_id: card.clipId,
    cue_index: card.cueIndex,
    phrase: card.phrase,
    context: card.context,
    ease: card.ease,
    reps: card.reps,
    interval: card.interval,
    due_date: card.dueDate,
    updated_at: card.updatedAt || new Date().toISOString(),
  };
}
function rowToCard(row) {
  return {
    id: row.id,
    clipId: row.clip_id,
    cueIndex: row.cue_index,
    phrase: row.phrase,
    context: row.context,
    ease: row.ease,
    reps: row.reps,
    interval: row.interval,
    dueDate: row.due_date,
    updatedAt: row.updated_at,
  };
}

async function pushClip(clip) {
  const client = getSupabaseClient();
  if (!client) return;
  const { error } = await client.from('clips').upsert(clipToRow(clip));
  if (error) console.error('pushClip failed', error);
}
async function pushCard(card) {
  const client = getSupabaseClient();
  if (!client) return;
  const { error } = await client.from('cards').upsert(cardToRow(card));
  if (error) console.error('pushCard failed', error);
}

async function deleteClipRemote(clipId) {
  const client = getSupabaseClient();
  if (!client) return;
  const { error } = await client.from('clips').delete().eq('id', clipId);
  if (error) console.error('deleteClipRemote failed', error);
}
async function deleteCardsForClipRemote(clipId) {
  const client = getSupabaseClient();
  if (!client) return;
  const { error } = await client.from('cards').delete().eq('clip_id', clipId);
  if (error) console.error('deleteCardsForClipRemote failed', error);
}

function reconcileWithRemote(localList, remoteList, toLocal) {
  const localById = new Map(localList.map(item => [item.id, item]));
  return remoteList.map(row => {
    const remote = toLocal(row);
    const local = localById.get(remote.id);
    if (local && local.updatedAt && new Date(local.updatedAt) > new Date(remote.updatedAt)) {
      return local;
    }
    return remote;
  });
}

async function syncFromSupabase() {
  const client = getSupabaseClient();
  if (!client) return;
  const [clipsRes, cardsRes] = await Promise.all([
    client.from('clips').select('*'),
    client.from('cards').select('*'),
  ]);
  if (clipsRes.error) console.error('sync clips failed', clipsRes.error);
  if (cardsRes.error) console.error('sync cards failed', cardsRes.error);

  if (!clipsRes.error && clipsRes.data) {
    const reconciled = reconcileWithRemote(loadClips(), clipsRes.data, rowToClip);
    saveClips(reconciled);
  }
  if (!cardsRes.error && cardsRes.data) {
    const reconciled = reconcileWithRemote(loadCards(), cardsRes.data, rowToCard);
    saveCards(reconciled);
  }
}

// ---------- view switching ----------
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const navBtn = document.querySelector(`.nav-btn[data-view="${name}"]`);
  if (navBtn) navBtn.classList.add('active');
  if (name === 'list') renderClipList();
  if (name === 'review') renderReview();
  if (name === 'settings') renderSettings();
  updateDueBadge();
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});
document.querySelectorAll('.back-btn').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.target));
});

// ---------- import ----------
document.getElementById('import-btn').addEventListener('click', () => {
  const raw = document.getElementById('import-textarea').value.trim();
  const msg = document.getElementById('import-msg');
  if (!raw) return;
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    msg.textContent = 'JSONの解析に失敗しました: ' + e.message;
    msg.style.color = 'var(--bad)';
    return;
  }
  if (!Array.isArray(data.cues) || data.cues.length === 0) {
    msg.textContent = 'cues が見つかりません。';
    msg.style.color = 'var(--bad)';
    return;
  }
  const clips = loadClips();
  const newClip = {
    id: uid(),
    capturedAt: data.capturedAt || new Date().toISOString(),
    pageUrl: data.pageUrl || '',
    title: data.title || '(無題のクリップ)',
    description: data.description || '',
    cues: data.cues,
    updatedAt: new Date().toISOString(),
  };
  clips.unshift(newClip);
  saveClips(clips);
  pushClip(newClip);
  msg.textContent = `取り込みました：「${data.title}」（字幕${data.cues.length}行）`;
  msg.style.color = 'var(--good)';
  document.getElementById('import-textarea').value = '';
  setTimeout(() => showView('list'), 800);
});

// ---------- clip list ----------
function renderClipList() {
  const container = document.getElementById('clip-list');
  const clips = loadClips();
  if (clips.length === 0) {
    container.innerHTML = '<p class="muted">まだクリップがありません。「取り込み」からJSONを貼り付けてください。</p>';
    return;
  }
  container.innerHTML = '';
  clips.forEach(clip => {
    const card = document.createElement('div');
    card.className = 'clip-card';
    const date = new Date(clip.capturedAt).toLocaleDateString('ja-JP');
    card.innerHTML = `
      <div class="clip-card-row">
        <div>
          <h3>${escapeHtml(clip.title)}</h3>
          <div class="meta">${date} ・ 字幕${clip.cues.length}行</div>
        </div>
        <button class="delete-clip-btn" data-id="${clip.id}">削除</button>
      </div>`;
    card.addEventListener('click', () => openClip(clip.id));
    container.appendChild(card);
  });

  container.querySelectorAll('.delete-clip-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!confirm('このクリップと関連する単語帳カードを削除しますか？')) return;
      deleteClip(id);
    });
  });
}

function deleteClip(clipId) {
  const clips = loadClips().filter(c => c.id !== clipId);
  saveClips(clips);
  const cards = loadCards().filter(c => c.clipId !== clipId);
  saveCards(cards);
  deleteClipRemote(clipId);
  deleteCardsForClipRemote(clipId);
  renderClipList();
  updateDueBadge();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- clip detail ----------
let currentClipId = null;
let currentMode = 'shadowing';

function openClip(clipId) {
  currentClipId = clipId;
  currentMode = 'shadowing';
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'shadowing'));
  const clip = loadClips().find(c => c.id === clipId);
  if (!clip) return;
  document.getElementById('clip-title').textContent = clip.title;
  document.getElementById('clip-desc').textContent = clip.description || '';
  const link = document.getElementById('clip-link');
  if (clip.pageUrl) {
    link.href = clip.pageUrl;
    link.style.display = 'inline';
  } else {
    link.style.display = 'none';
  }
  document.getElementById('cue-list').hidden = false;
  document.getElementById('narration-panel').hidden = true;
  document.getElementById('narration-textarea').value = '';
  document.getElementById('narration-status').textContent = '';
  document.getElementById('narration-result').innerHTML = '';
  renderCues(clip);
  showViewRaw('clip');
}

document.getElementById('edit-title-btn').addEventListener('click', () => {
  const clips = loadClips();
  const clip = clips.find(c => c.id === currentClipId);
  if (!clip) return;
  const newTitle = prompt('新しいタイトル:', clip.title);
  if (!newTitle || !newTitle.trim()) return;
  clip.title = newTitle.trim();
  clip.updatedAt = new Date().toISOString();
  saveClips(clips);
  pushClip(clip);
  document.getElementById('clip-title').textContent = clip.title;
});

function showViewRaw(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
}

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentMode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
    const clip = loadClips().find(c => c.id === currentClipId);
    if (!clip) return;
    if (currentMode === 'narration') {
      document.getElementById('cue-list').hidden = true;
      document.getElementById('narration-panel').hidden = false;
    } else {
      document.getElementById('cue-list').hidden = false;
      document.getElementById('narration-panel').hidden = true;
      renderCues(clip);
    }
  });
});

function renderCues(clip) {
  const container = document.getElementById('cue-list');
  container.innerHTML = '';
  clip.cues.forEach((cue, i) => {
    const row = document.createElement('div');
    row.className = 'cue-row';
    const time = `<div class="cue-time">${formatTime(cue.start)}</div>`;

    if (currentMode === 'shadowing') {
      row.innerHTML = `${time}<div class="cue-text">${escapeHtml(cue.text)}</div>
        <div class="cue-actions"><button data-i="${i}" class="card-btn">単語帳に追加</button></div>`;
    } else {
      row.innerHTML = `${time}
        <input type="text" class="dictation-input" placeholder="聞き取った英文を入力" data-i="${i}">
        <div class="cue-actions"><button data-i="${i}" class="check-btn">答え合わせ</button></div>
        <div class="diff-result" data-i="${i}"></div>`;
    }
    container.appendChild(row);
  });

  container.querySelectorAll('.card-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i);
      addCardFromCue(clip, i);
    });
  });
  container.querySelectorAll('.check-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i);
      checkDictation(clip, i);
    });
  });
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function addCardFromCue(clip, cueIndex) {
  const cue = clip.cues[cueIndex];
  const phrase = prompt('カードにする単語・フレーズを入力（そのままでもOK）:', cue.text);
  if (!phrase) return;
  const cards = loadCards();
  const newCard = {
    id: uid(),
    clipId: clip.id,
    cueIndex,
    phrase: phrase.trim(),
    context: cue.text,
    ease: 2.5,
    reps: 0,
    interval: 0,
    dueDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  cards.push(newCard);
  saveCards(cards);
  pushCard(newCard);
  updateDueBadge();
  alert('単語帳に追加しました。');
}

function normalizeForDiff(str) {
  return str.toLowerCase().replace(/[.,!?;:'"]/g, '').trim().split(/\s+/).filter(Boolean);
}

function checkDictation(clip, cueIndex) {
  const cue = clip.cues[cueIndex];
  const input = document.querySelector(`.dictation-input[data-i="${cueIndex}"]`);
  const resultEl = document.querySelector(`.diff-result[data-i="${cueIndex}"]`);
  const userWords = normalizeForDiff(input.value);
  const correctWords = normalizeForDiff(cue.text);

  const rendered = correctWords.map((w, i) => {
    const match = userWords[i] === w;
    return `<span class="${match ? 'diff-correct' : 'diff-wrong'}">${escapeHtml(w)}</span>`;
  }).join(' ');

  resultEl.innerHTML = `<div style="margin-top:6px;">${rendered}</div><div class="muted" style="margin-top:4px;">正解: ${escapeHtml(cue.text)}</div>`;
}

// ---------- SRS review ----------
function scheduleCard(card, quality) {
  if (typeof card.ease !== 'number') card.ease = 2.5;
  if (typeof card.reps !== 'number') card.reps = 0;
  if (typeof card.interval !== 'number') card.interval = 0;

  if (quality < 3) {
    card.reps = 0;
    card.interval = 1;
  } else {
    if (card.reps === 0) card.interval = 1;
    else if (card.reps === 1) card.interval = 6;
    else card.interval = Math.round(card.interval * card.ease);
    card.reps += 1;
  }
  card.ease = Math.max(1.3, card.ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
  const due = new Date();
  due.setDate(due.getDate() + card.interval);
  card.dueDate = due.toISOString();
  card.updatedAt = new Date().toISOString();
}

function getDueCards() {
  const now = new Date();
  return loadCards().filter(c => !c.dueDate || new Date(c.dueDate) <= now);
}

function updateDueBadge() {
  const count = getDueCards().length;
  const badge = document.getElementById('due-count');
  if (count > 0) {
    badge.textContent = count;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

let reviewQueue = [];

function renderReview() {
  reviewQueue = getDueCards();
  showNextReviewCard();
}

function showNextReviewCard() {
  const empty = document.getElementById('review-empty');
  const cardView = document.getElementById('review-card');
  if (reviewQueue.length === 0) {
    empty.hidden = false;
    cardView.hidden = true;
    return;
  }
  empty.hidden = true;
  cardView.hidden = false;

  const card = reviewQueue[0];
  document.getElementById('review-progress').textContent = `残り ${reviewQueue.length} 枚`;
  document.getElementById('review-front').textContent = card.phrase;
  document.getElementById('review-context').textContent = '';
  document.getElementById('review-back').hidden = true;
  document.getElementById('review-answer').textContent = card.context;
}

document.getElementById('review-reveal-btn').addEventListener('click', () => {
  document.getElementById('review-back').hidden = false;
});

document.querySelectorAll('.rate-row button').forEach(btn => {
  btn.addEventListener('click', () => {
    const quality = Number(btn.dataset.quality);
    const card = reviewQueue.shift();
    const cards = loadCards();
    const idx = cards.findIndex(c => c.id === card.id);
    if (idx !== -1) {
      scheduleCard(cards[idx], quality);
      saveCards(cards);
      pushCard(cards[idx]);
    }
    updateDueBadge();
    showNextReviewCard();
  });
});

// ---------- settings / Gemini feedback ----------
function loadGeminiKey() {
  return localStorage.getItem(STORAGE_GEMINI_KEY) || '';
}
function saveGeminiKey(key) {
  localStorage.setItem(STORAGE_GEMINI_KEY, key);
}

function renderSettings() {
  const msg = document.getElementById('save-key-msg');
  msg.textContent = loadGeminiKey()
    ? 'キーは登録済みです（上書きする場合は新しい値を入力して保存してください）。'
    : 'まだキーが登録されていません。';

  const supabaseMsg = document.getElementById('save-supabase-msg');
  const { url } = loadSupabaseConfig();
  supabaseMsg.textContent = url
    ? `同期設定済み（${url}）。上書きする場合は新しい値を入力して保存してください。`
    : 'まだ同期設定されていません。';
}

document.getElementById('save-supabase-btn').addEventListener('click', async () => {
  const url = document.getElementById('supabase-url-input').value.trim();
  const key = document.getElementById('supabase-key-input').value.trim();
  const msg = document.getElementById('save-supabase-msg');
  if (!url || !key) {
    msg.textContent = 'URLとキーの両方を入力してください。';
    return;
  }
  saveSupabaseConfig(url, key);
  document.getElementById('supabase-url-input').value = '';
  document.getElementById('supabase-key-input').value = '';
  msg.textContent = '同期中...';
  try {
    await syncFromSupabase();
    msg.textContent = '保存して同期しました。';
    renderClipList();
    updateDueBadge();
  } catch (e) {
    msg.textContent = '同期エラー: ' + e.message;
  }
});

document.getElementById('save-key-btn').addEventListener('click', () => {
  const val = document.getElementById('gemini-key-input').value.trim();
  if (!val) return;
  saveGeminiKey(val);
  document.getElementById('gemini-key-input').value = '';
  document.getElementById('save-key-msg').textContent = '保存しました。';
});

async function callGeminiFeedback(userNarration, broadcastText) {
  const key = loadGeminiKey();
  if (!key) {
    throw new Error('Gemini APIキーが設定されていません。「設定」画面で登録してください。');
  }
  const model = 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{
      role: 'user',
      parts: [{
        text: `【実際の放送実況】\n${broadcastText}\n\n【学習者が書いた実況】\n${userNarration}`,
      }],
    }],
    systemInstruction: {
      parts: [{
        text: 'あなたは日本人の英語学習者を指導するプロの英語コーチです。MLB実況の「自分実況」練習を評価します。実際の放送実況と学習者の英文を比較し、文法・語彙選択・自然さについて日本語で簡潔に（箇条書き3〜5点）フィードバックしてください。良かった点も必ず1つ以上挙げてください。',
      }],
    },
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`APIエラー (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('応答からテキストを取得できませんでした。');
  return text;
}

document.getElementById('narration-btn').addEventListener('click', async () => {
  const clip = loadClips().find(c => c.id === currentClipId);
  if (!clip) return;
  const narrationText = document.getElementById('narration-textarea').value.trim();
  const statusEl = document.getElementById('narration-status');
  const resultEl = document.getElementById('narration-result');

  if (!narrationText) {
    statusEl.textContent = '実況を入力してください。';
    return;
  }

  statusEl.textContent = 'フィードバックを取得中...';
  resultEl.innerHTML = '';

  const broadcastText = clip.cues.map(c => c.text).join(' ');
  try {
    const feedback = await callGeminiFeedback(narrationText, broadcastText);
    statusEl.textContent = '';
    resultEl.innerHTML = escapeHtml(feedback).replace(/\n/g, '<br>');
  } catch (e) {
    statusEl.textContent = '';
    resultEl.innerHTML = `<p style="color:var(--bad)">${escapeHtml(e.message)}</p>`;
  }
});

// ---------- init ----------
updateDueBadge();
renderClipList();

if (getSupabaseClient()) {
  syncFromSupabase().then(() => {
    renderClipList();
    updateDueBadge();
  }).catch(e => console.error('initial sync failed', e));
}
