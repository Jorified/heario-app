import { useState, useEffect, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { jsPDF } from "jspdf";
import "./App.css";

const WS_URL = "ws://localhost:7433";
const MODE_ICONS  = { technical_interview:"💻", behavioral:"🧩", sales:"💼", lecture:"📖", recruiting:"🤝", system_design:"🗂️", mock_interview:"🎭" };
const MODE_LABELS = { technical_interview:"Technical", behavioral:"Behavioral", sales:"Sales", lecture:"Lecture", recruiting:"Recruiting", system_design:"System Design", mock_interview:"Mock Interview" };
const FONT_SIZES    = [11, 12, 13, 14, 16, 18];
const OPACITY_STEPS = [0, 0.15, 0.35, 0.55, 0.78, 1.0];
const MAX_TX_LINES  = 8;
const CONF_COLORS   = ["#888", "#f05b5b", "#d98b3a", "#f5bf4f", "#8bc34a", "#5fb85f"];
const FULL_SIZE      = { width: 580, height: 400 };
const DISCREET_SIZE  = { width: 200, height: 34 };

// ── Settings Modal ────────────────────────────────────────────────────────────
function SettingsModal({ onClose, liveBrief, onResearch, researching, researchError }) {
  const DEFAULT_PROMPTS = {
    technical_interview: "You are a silent assistant helping the user pass a live technical interview. Given the interviewer's latest question, produce a crisp, correct answer the user can speak in ~20-40 seconds. Prefer concrete examples. If it's a coding question, give the approach + key code, not an essay.",
    behavioral: "You help the user answer behavioral interview questions using the STAR method, grounded in the user's real background below. Keep it to one tight, specific story.",
    sales: "You are a real-time sales co-pilot. Given the prospect's last statement/objection, suggest the user's next line: handle the objection, ask a sharp discovery question, or advance the deal.",
    lecture: "You are a note-taker. Given the lecturer's latest speech, output the key point as a concise bullet the user can save. No answers, just clear notes.",
    recruiting: "You are a silent assistant helping a recruiter or hiring manager run a live interview. Given the candidate's last response, suggest one sharp follow-up probing question, flag any vague or rehearsed answer, and highlight strong signals like ownership, specificity, or growth mindset. Keep feedback to 1-2 lines — actionable, not a lecture.",
    system_design: "You are a silent assistant helping the user ace a live system design interview. When the interviewer asks about designing a system, give a structured hint: suggest clarifying questions to ask first, outline the key architecture components, and flag scalability concerns (load balancing, caching, DB sharding, CDN). Be concise and technical.",
    mock_interview: "You are a tough but fair mock interview coach. When the user gives a response, point out what was weak or vague, suggest a stronger phrasing or missing detail, and ask a follow-up question a real interviewer would ask. Be direct and specific — no padding.",
  };
  const [form, setForm] = useState({
    license_key:"",
    anthropic_key:"", openai_key:"", deepgram_key:"", tavily_key:"",
    llm_provider:"anthropic", context:"", job_description:"",
    company_name:"", company_brief:"",
    target_speaker:"auto", user_speaker:"none", default_mode:"technical_interview",
    audio_source:"microphone",
    stt_backend:"auto",
    speaker_names:["Voice 1","Voice 2","Voice 3","Voice 4"],
    mode_prompts:{},
  });
  const [editingMode, setEditingMode] = useState("technical_interview");
  const [autostart, setAutostart] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [presets, setPresets] = useState({});
  const [presetName, setPresetName] = useState("");
  const [selectedPreset, setSelectedPreset] = useState("");

  useEffect(() => {
    Promise.all([invoke("get_settings"), invoke("get_autostart"), invoke("list_company_presets")])
      .then(([s, a, p]) => {
        setForm({ ...s, speaker_names: s.speaker_names?.length ? s.speaker_names : ["Voice 1","Voice 2","Voice 3","Voice 4"] });
        setAutostart(a);
        setPresets(p || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const applyPreset = (name) => {
    setSelectedPreset(name);
    const p = presets[name];
    if (!p) return;
    setForm(f => ({
      ...f,
      company_name:    p.company_name,
      job_description: p.job_description,
      company_brief:   p.company_brief,
      default_mode:    p.default_mode,
      mode_prompts:    { ...f.mode_prompts, ...p.mode_prompts },
    }));
  };

  const saveCurrentAsPreset = async () => {
    const name = presetName.trim();
    if (!name) return;
    const preset = {
      company_name:    form.company_name || "",
      job_description: form.job_description || "",
      company_brief:   liveBrief || form.company_brief || "",
      default_mode:    form.default_mode,
      mode_prompts:    form.mode_prompts || {},
    };
    await invoke("save_company_preset", { name, preset });
    setPresets(p => ({ ...p, [name]: preset }));
    setSelectedPreset(name);
    setPresetName("");
  };

  const deletePreset = async (name) => {
    if (!name) return;
    await invoke("delete_company_preset", { name });
    setPresets(p => { const next = { ...p }; delete next[name]; return next; });
    if (selectedPreset === name) setSelectedPreset("");
  };

  const save = async () => {
    await invoke("save_settings", { settings: form });
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(form); }, 800);
  };

  const saveAndRestart = async () => {
    await invoke("save_settings", { settings: form });
    await invoke("restart_sidecar");
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(form); }, 800);
  };

  const toggleAutostart = async () => {
    const next = !autostart;
    await invoke("set_autostart", { enabled: next });
    setAutostart(next);
  };

  if (loading) return <div className="modal-overlay"><div className="modal">Loading…</div></div>;

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <span>⚙ Settings</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <section className="settings-section">
            <div className="settings-label">License</div>
            <label className="settings-field">
              <span>License Key</span>
              <input type="text" value={form.license_key}
                onChange={e => setForm(f => ({...f, license_key: e.target.value}))}
                placeholder="HEAR-XXXX-XXXX-XXXX (from your purchase email)" />
            </label>
            <div className="settings-hint">On a paid plan? Paste the key emailed to you to use Heario's managed AI — no API key needed below. Otherwise leave blank and bring your own Anthropic key.</div>
          </section>

          <section className="settings-section">
            <div className="settings-label">AI Provider</div>
            <label className="settings-field">
              <span>Provider</span>
              <select value={form.llm_provider}
                onChange={e => setForm(f => ({...f, llm_provider: e.target.value}))}>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai">OpenAI (GPT-4o)</option>
              </select>
            </label>
            <label className="settings-field">
              <span>Anthropic</span>
              <input type="password" value={form.anthropic_key}
                onChange={e => setForm(f => ({...f, anthropic_key: e.target.value}))}
                placeholder="Add your own" />
            </label>
            <label className="settings-field">
              <span>OpenAI</span>
              <input type="password" value={form.openai_key}
                onChange={e => setForm(f => ({...f, openai_key: e.target.value}))}
                placeholder="Add your own" />
            </label>
            <label className="settings-field">
              <span>Deepgram</span>
              <input type="password" value={form.deepgram_key}
                onChange={e => setForm(f => ({...f, deepgram_key: e.target.value}))}
                placeholder="Add your own" />
            </label>
            <label className="settings-field">
              <span>Web Search</span>
              <input type="password" value={form.tavily_key}
                onChange={e => setForm(f => ({...f, tavily_key: e.target.value}))}
                placeholder="tvly-… (free at tavily.com)" />
            </label>
            <div className="settings-hint">Transcription priority: Deepgram (if key set) → OpenAI Whisper API (if OpenAI key set) → Local Whisper (no key needed, works offline). Changes take effect after Save &amp; Apply.</div>
          </section>

          <section className="settings-section">
            <div className="settings-label">Your Background</div>
            <textarea className="settings-textarea" rows={5}
              value={form.context}
              onChange={e => setForm(f => ({...f, context: e.target.value}))}
              placeholder="Paste your CV, bio, or key talking points here…" />
            <div className="settings-hint">Your background is injected into every AI answer so responses feel personal and grounded in your real experience.</div>
          </section>

          <section className="settings-section">
            <div className="settings-label">Job Description</div>
            <textarea className="settings-textarea" rows={5}
              value={form.job_description || ""}
              onChange={e => setForm(f => ({...f, job_description: e.target.value}))}
              placeholder="Paste the job description you're interviewing for…" />
            <div className="settings-hint">Claude will tailor every answer to this specific role, company, and requirements. Update it before each interview for best results.</div>
          </section>

          <section className="settings-section">
            <div className="settings-label">Company Research</div>
            <label className="settings-field">
              <span>Company</span>
              <input type="text" value={form.company_name || ""}
                onChange={e => setForm(f => ({...f, company_name: e.target.value}))}
                placeholder="e.g. Stripe, Anthropic, Google…" />
            </label>
            <button className="action-btn" style={{ alignSelf:"flex-start" }}
              disabled={!form.company_name?.trim() || researching}
              onClick={() => onResearch(form.company_name.trim())}>
              {researching ? "Researching…" : "🔍 Research"}
            </button>
            {researchError && <span className="quick-debrief-error">{researchError}</span>}
            {(liveBrief || form.company_brief) && (
              <textarea className="settings-textarea" rows={6} readOnly
                value={liveBrief || form.company_brief} />
            )}
            <div className="settings-hint">Heario searches the web and generates a company brief — industry, recent news, values — injected into every AI answer automatically. Click Research before each interview.</div>
          </section>

          <section className="settings-section">
            <div className="settings-label">Quick-mode Presets per Company</div>
            <label className="settings-field">
              <span>Saved presets</span>
              <select value={selectedPreset} onChange={e => applyPreset(e.target.value)}>
                <option value="">— select to apply —</option>
                {Object.keys(presets).sort().map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
            {selectedPreset && (
              <button className="action-btn" style={{ alignSelf:"flex-start" }}
                onClick={() => deletePreset(selectedPreset)}>
                🗑 Delete "{selectedPreset}"
              </button>
            )}
            <label className="settings-field">
              <span>Save current as</span>
              <input type="text" value={presetName}
                onChange={e => setPresetName(e.target.value)}
                placeholder="e.g. Stripe, Anthropic…" />
            </label>
            <button className="action-btn" style={{ alignSelf:"flex-start" }}
              disabled={!presetName.trim()} onClick={saveCurrentAsPreset}>
              💾 Save Preset
            </button>
            <div className="settings-hint">Saves company name, job description, brief, default mode, and mode prompts together. Applying a preset instantly swaps your whole setup when prepping for a different company — no retyping.</div>
          </section>

          <section className="settings-section">
            <div className="settings-label">Audio</div>
            <label className="settings-field">
              <span>Audio Source</span>
              <select value={form.audio_source || 'microphone'}
                onChange={e => setForm(f => ({...f, audio_source: e.target.value}))}>
                <option value="microphone">Microphone</option>
                <option value="loopback">System Audio (WASAPI Loopback)</option>
              </select>
            </label>
            <label className="settings-field">
              <span>Transcription</span>
              <select value={form.stt_backend || 'auto'}
                onChange={e => setForm(f => ({...f, stt_backend: e.target.value}))}>
                <option value="auto">Auto (best available)</option>
                <option value="whisper">Local Whisper (offline, no key)</option>
                <option value="openai">OpenAI Whisper API (uses OpenAI key)</option>
                <option value="deepgram">Deepgram (requires Deepgram key)</option>
              </select>
            </label>
            <div className="settings-hint">Auto picks the best available: Deepgram → OpenAI Whisper API → Local Whisper. Choose manually to control which key is used for transcription. Changes take effect after Save &amp; Apply.</div>
          </section>

          <section className="settings-section">
            <div className="settings-label">Mode Prompts</div>
            <label className="settings-field">
              <span>Mode</span>
              <select value={editingMode} onChange={e => setEditingMode(e.target.value)}>
                <option value="technical_interview">💻 Technical Interview</option>
                <option value="behavioral">🧩 Behavioral</option>
                <option value="sales">💼 Sales</option>
                <option value="lecture">📖 Lecture</option>
                <option value="recruiting">🤝 Recruiting</option>
                <option value="system_design">🗂️ System Design</option>
                <option value="mock_interview">🎭 Mock Interview</option>
              </select>
            </label>
            <textarea className="settings-textarea" rows={5}
              value={form.mode_prompts?.[editingMode] ?? DEFAULT_PROMPTS[editingMode] ?? ""}
              onChange={e => setForm(f => ({...f, mode_prompts:{...f.mode_prompts, [editingMode]: e.target.value}}))}
              placeholder="Describe how the AI should respond in this mode…" />
            <div className="settings-hint">This is the instruction Claude receives for this mode. Changes take effect after Save &amp; Apply.</div>
          </section>

          <section className="settings-section">
            <div className="settings-label">Speaker Names</div>
            {(form.speaker_names || ["Voice 1","Voice 2","Voice 3","Voice 4"]).map((name, i) => (
              <label className="settings-field" key={i}>
                <span>Speaker {i}</span>
                <input type="text" value={name} maxLength={20}
                  onChange={e => setForm(f => {
                    const names = [...(f.speaker_names || ["Voice 1","Voice 2","Voice 3","Voice 4"])];
                    names[i] = e.target.value;
                    return {...f, speaker_names: names};
                  })} />
              </label>
            ))}
          </section>

          <section className="settings-section">
            <div className="settings-label">Behaviour</div>
            <label className="settings-field">
              <span>Default mode</span>
              <select value={form.default_mode}
                onChange={e => setForm(f => ({...f, default_mode: e.target.value}))}>
                <option value="technical_interview">💻 Technical Interview</option>
                <option value="behavioral">🧩 Behavioral</option>
                <option value="sales">💼 Sales</option>
                <option value="lecture">📖 Lecture</option>
                <option value="recruiting">🤝 Recruiting</option>
                <option value="system_design">🗂️ System Design</option>
                <option value="mock_interview">🎭 Mock Interview</option>
              </select>
            </label>
            <label className="settings-field">
              <span>Target speaker</span>
              <select value={form.target_speaker}
                onChange={e => setForm(f => ({...f, target_speaker: e.target.value}))}>
                <option value="auto">Auto (first questioner)</option>
                <option value="all">All speakers</option>
                <option value="0">Speaker 0</option>
                <option value="1">Speaker 1</option>
              </select>
            </label>
            <label className="settings-field">
              <span>My speaker</span>
              <select value={form.user_speaker || "none"}
                onChange={e => setForm(f => ({...f, user_speaker: e.target.value}))}>
                <option value="none">Not set (feature off)</option>
                {(form.speaker_names || ["Voice 1","Voice 2","Voice 3","Voice 4"]).map((name, i) => (
                  <option key={i} value={String(i)}>{name}</option>
                ))}
              </select>
            </label>
            <div className="settings-hint">Set this to your own voice. Heario will suppress new answers while you're speaking and for 2.5 s after — so it never interrupts mid-answer.</div>
          </section>

          <section className="settings-section">
            <div className="settings-label">System</div>
            <label className="settings-toggle">
              <span>Launch at login</span>
              <div className={`toggle${autostart ? " on" : ""}`} onClick={toggleAutostart}>
                <div className="toggle-thumb" />
              </div>
            </label>
          </section>
        </div>

        <div className="modal-footer">
          <button className="action-btn" onClick={save}>
            {saved ? "✓ Saved" : "Save"}
          </button>
          <button className="action-btn regen" onClick={saveAndRestart}
            title="Save settings and restart the audio pipeline">
            Save & Apply
          </button>
        </div>
      </div>
    </div>
  );
}

// ── History Modal ─────────────────────────────────────────────────────────────
function HistoryModal({ onClose }) {
  const [sessions, setSessions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [exported, setExported] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState(null); // null = no search active
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    invoke("list_sessions").then(s => { setSessions(s); setLoading(false); });
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setMatches(null); return; }
    setSearching(true);
    const t = setTimeout(() => {
      invoke("search_sessions", { query: q })
        .then(setMatches)
        .finally(() => setSearching(false));
    }, 200); // debounce while typing
    return () => clearTimeout(t);
  }, [query]);

  const open = async (name) => {
    setSelected(name);
    setExported(false);
    const txt = await invoke("read_session", { name });
    setContent(txt);
  };

  const openFolder = () => invoke("open_sessions_folder");

  const savePDF = () => {
    if (!content) return;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const margin = 40;
    const pageW = doc.internal.pageSize.getWidth();
    const maxW = pageW - margin * 2;
    const lineH = 13;
    let y = margin;

    const addLine = (text, size = 10, style = "normal", color = [40, 40, 40]) => {
      doc.setFontSize(size);
      doc.setFont("helvetica", style);
      doc.setTextColor(...color);
      const lines = doc.splitTextToSize(text, maxW);
      lines.forEach(line => {
        if (y > doc.internal.pageSize.getHeight() - margin) {
          doc.addPage(); y = margin;
        }
        doc.text(line, margin, y);
        y += lineH;
      });
    };

    const name = selected?.replace("session-", "").replace(".txt", "") ?? "session";
    addLine(`Heario Session — ${name}`, 14, "bold", [30, 30, 30]);
    y += 6;
    content.split("\n").forEach(line => {
      if (line.startsWith("="))      { y += 4; return; }
      if (line.startsWith("["))      addLine(line, 10, "bold", [50, 100, 180]);
      else if (line.startsWith("  AI:")) addLine(line, 10, "normal", [40, 40, 40]);
      else if (line.trim())          addLine(line, 10, "normal", [80, 80, 80]);
      else                           y += 4;
    });
    doc.save(`heario-${name}.pdf`);
    setExported(true);
    setTimeout(() => setExported(false), 2000);
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <div className="modal-header">
          <span>🕐 Session History</span>
          <div style={{ display:"flex", gap:6 }}>
            <button className="action-btn" onClick={openFolder} title="Open sessions folder in Explorer">
              📂 Folder
            </button>
            {content && (
              <button className="action-btn" onClick={savePDF}>
                {exported ? "✓ Saved" : "⬇ PDF"}
              </button>
            )}
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="history-search">
          <input
            className="history-search-input"
            placeholder="🔍 Search past questions & answers…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && (
            <button className="action-btn" onClick={() => setQuery("")}>✕</button>
          )}
        </div>
        <div className="history-body">
          <div className="history-list">
            {loading && <span className="placeholder">Loading…</span>}
            {!loading && sessions.length === 0 && <span className="placeholder">No sessions yet</span>}

            {!loading && query && (
              <>
                {searching && <span className="placeholder">Searching…</span>}
                {!searching && matches && matches.length === 0 && (
                  <span className="placeholder">No matches for "{query}"</span>
                )}
                {!searching && matches && matches.map(m => (
                  <div key={m.name} className={`history-item history-match${selected === m.name ? " active" : ""}`}
                    onClick={() => open(m.name)}>
                    <div className="history-match-name">{m.name.replace("session-","").replace(".txt","")}</div>
                    {m.snippets.map((sn, i) => (
                      <div key={i} className="history-match-snippet">{sn}</div>
                    ))}
                  </div>
                ))}
              </>
            )}

            {!loading && !query && sessions.map(s => (
              <div key={s} className={`history-item${selected === s ? " active" : ""}`}
                onClick={() => open(s)}>
                {s.replace("session-","").replace(".txt","")}
              </div>
            ))}
          </div>
          <div className="history-content">
            {content
              ? <pre className="history-pre">{content}</pre>
              : <span className="placeholder">Select a session to view</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Pinned Answers Modal ──────────────────────────────────────────────────────
function PinnedModal({ pinned, onUnpin, onClose }) {
  const [copiedId, setCopiedId] = useState(null);

  const copy = async (item) => {
    await writeText(item.text);
    setCopiedId(item.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <div className="modal-header">
          <span>📌 Pinned Answers</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {pinned.length === 0 && <span className="placeholder">No pinned answers yet — click 📌 Pin on an answer to save it here.</span>}
          {pinned.map(item => (
            <div key={item.id} className="pinned-item">
              <div className="pinned-item-head">
                <span className="pinned-item-mode">{MODE_ICONS[item.mode]} {MODE_LABELS[item.mode] ?? item.mode}</span>
                <span className="pinned-item-time">{item.ts}</span>
                <div className="spacer" />
                <button className="action-btn" onClick={() => copy(item)}>
                  {copiedId === item.id ? "✓ Copied" : "⧉ Copy"}
                </button>
                <button className="action-btn" onClick={() => onUnpin(item.id)}>✕ Unpin</button>
              </div>
              <pre className="pinned-item-text">{item.text}</pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Post-interview Debrief Modal ───────────────────────────────────────────────
// groups raw "HEADING\n- bullet\n- bullet" text into {title, lines} sections for display
function parseDebrief(text) {
  const sections = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^[A-Z][A-Z -]{3,}$/.test(line)) {
      current = { title: line, lines: [] };
      sections.push(current);
    } else if (line) {
      if (!current) { current = { title: null, lines: [] }; sections.push(current); }
      current.lines.push(line.replace(/^[-•]\s*/, ""));
    }
  }
  return sections;
}

function downloadDebriefPDF(text, title = "Heario Debrief") {
  if (!text) return;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const margin = 40;
  const pageW = doc.internal.pageSize.getWidth();
  const maxW = pageW - margin * 2;
  const lineH = 13;
  let y = margin;

  const addLine = (line, size = 10, style = "normal", color = [40, 40, 40]) => {
    doc.setFontSize(size);
    doc.setFont("helvetica", style);
    doc.setTextColor(...color);
    doc.splitTextToSize(line, maxW).forEach(l => {
      if (y > doc.internal.pageSize.getHeight() - margin) { doc.addPage(); y = margin; }
      doc.text(l, margin, y);
      y += lineH;
    });
  };

  addLine(`${title} — ${new Date().toLocaleString()}`, 14, "bold", [30, 30, 30]);
  y += 6;
  text.split("\n").forEach(line => {
    if (/^[A-Z ]{4,}$/.test(line.trim())) addLine(line, 11, "bold", [50, 100, 180]);
    else if (line.trim())                 addLine(line, 10, "normal", [60, 60, 60]);
    else                                   y += 4;
  });
  doc.save(`heario-debrief-${Date.now()}.pdf`);
}

function DebriefModal({ text, loading, paywalled, onClose }) {
  const [exported, setExported] = useState(false);

  const savePDF = () => {
    downloadDebriefPDF(text, "Heario Quick Debrief");
    setExported(true);
    setTimeout(() => setExported(false), 2000);
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <div className="modal-header">
          <span>📝 Quick Debrief</span>
          {!loading && !paywalled && text && (
            <button className="action-btn" onClick={savePDF}>
              {exported ? "✓ Saved" : "⬇ PDF"}
            </button>
          )}
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {paywalled ? (
            <span className="placeholder">
              You've used your free Quick Debrief. Upgrade to a paid plan for a debrief after
              every session, unlimited — enter your license key in Settings, or get one at{" "}
              <a href="https://heario.ai/#pricing" target="_blank" rel="noreferrer">heario.ai/#pricing</a>.
            </span>
          ) : loading ? (
            <span className="placeholder">Generating debrief…</span>
          ) : parseDebrief(text).map((s, i) => (
            <div key={i} className="debrief-section">
              {s.title && <div className="debrief-section-title">{s.title}</div>}
              <ul className="debrief-list">
                {s.lines.map((l, j) => <li key={j}>{l}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const QUICK_DEBRIEF_KEY = "heario_quick_debrief_used";
const QUICK_DEBRIEF_TEXT_KEY = "heario_quick_debrief_text";
const END_DEBRIEF_KEY = "heario_end_debrief_used";
const NOTES_KEY = "heario_notes";

// turns free-typed notes into a "NOTES" section matching the debrief's own
// ALL-CAPS-header format, so parseDebrief/downloadDebriefPDF render it identically
function appendNotesSection(debriefText, notes) {
  const trimmed = (notes || "").trim();
  if (!trimmed) return debriefText;
  const bullets = trimmed.split("\n").map(l => l.trim()).filter(Boolean).map(l => `- ${l}`).join("\n");
  return `${debriefText}\n\nNOTES\n${bullets}`;
}

// ── Notes Modal (free-typed notes, carried into the next debrief) ───────────
function NotesModal({ notes, onChange, onClose }) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <div className="modal-header">
          <span>📓 Notes</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <span className="settings-hint">
            Jot down anything worth remembering — it's added as a NOTES section to your next
            Quick Debrief or Practice Recap.
          </span>
          <textarea
            className="settings-textarea"
            rows={10}
            autoFocus
            placeholder="e.g. forgot to mention the caching layer on the scaling question…"
            value={notes}
            onChange={e => onChange(e.target.value)}
          />
        </div>
        {notes.trim() && (
          <div className="modal-footer">
            <button className="action-btn" onClick={() => onChange("")}>Clear notes</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Quick Debrief Modal (free, one-time typed-Q&A teaser) ────────────────────
function QuickDebriefModal({ onClose, onGenerated, alreadyUsed }) {
  const [qa, setQa]           = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(() => localStorage.getItem(QUICK_DEBRIEF_TEXT_KEY) || "");
  const [error, setError]     = useState("");
  const [exported, setExported] = useState(false);

  const generate = () => {
    if (!qa.trim()) return;
    setLoading(true);
    setError("");
    onGenerated(qa, (res) => {
      setLoading(false);
      if (res.error) { setError(res.error); return; }
      setResult(res.text);
      localStorage.setItem(QUICK_DEBRIEF_TEXT_KEY, res.text);
    });
  };

  const savePDF = () => {
    downloadDebriefPDF(result, "Heario Practice Recap");
    setExported(true);
    setTimeout(() => setExported(false), 2000);
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <div className="modal-header">
          <span>✍️ Practice Recap</span>
          {result && !loading && (
            <button className="action-btn" onClick={savePDF}>
              {exported ? "✓ Saved" : "⬇ PDF"}
            </button>
          )}
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {alreadyUsed && !result ? (
            <span className="placeholder">
              You've used your free Practice Recap. Start a live session to get a debrief
              after every interview, unlimited.
            </span>
          ) : loading ? (
            <span className="placeholder">Generating debrief…</span>
          ) : result ? (
            parseDebrief(result).map((s, i) => (
              <div key={i} className="debrief-section">
                {s.title && <div className="debrief-section-title">{s.title}</div>}
                <ul className="debrief-list">
                  {s.lines.map((l, j) => <li key={j}>{l}</li>)}
                </ul>
              </div>
            ))
          ) : (
            <>
              <span className="settings-hint">
                Paste or type a question you were asked and the answer you gave — get a free
                debrief with follow-ups to prepare. One free use per install.
              </span>
              <textarea
                className="settings-textarea"
                rows={6}
                placeholder={"Q: How would you scale this to 10M requests/day?\nA: Shard by tenant, cache hot reads, queue the writes."}
                value={qa}
                onChange={e => setQa(e.target.value)}
              />
              {error && <span className="quick-debrief-error">{error}</span>}
            </>
          )}
        </div>
        {!alreadyUsed && !result && (
          <div className="modal-footer">
            <button className="action-btn" onClick={generate} disabled={!qa.trim() || loading}>
              {loading ? "Generating…" : error ? "Try again" : "Generate my free debrief"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const ws             = useRef(null);
  const reconnectTimer = useRef(null);
  const endSessionTimer = useRef(null);
  const quickDebriefTimer = useRef(null);
  const ansRef         = useRef(null);
  const txRef          = useRef(null);
  const bodyRef        = useRef(null);
  const pausedRef      = useRef(false);
  const askRef         = useRef(null);

  const [status,       setStatus]      = useState("connecting");
  const [mode,         setMode]        = useState("technical_interview");
  const [answer,       setAnswer]      = useState("");
  const [pos,          setPos]         = useState(0);
  const [total,        setTotal]       = useState(0);
  const [wsState,      setWsState]     = useState("connecting");
  const [paused,       setPaused]      = useState(true);
  const [webEnabled,   setWebEnabled]  = useState(false);
  const [answersEnabled, setAnswersEnabled] = useState(true);
  const [fontIdx,      setFontIdx]     = useState(2);
  const [opacityIdx,   setOpacityIdx]  = useState(5);
  const [copied,       setCopied]      = useState(false);
  const [isMaximized,  setIsMaximized] = useState(false);
  const [txLines,      setTxLines]     = useState([]);
  const [confidence,   setConfidence]  = useState(0);
  const [txHeight,     setTxHeight]    = useState(35); // % of body
  const [showSettings, setShowSettings]= useState(false);
  const [showHistory,  setShowHistory] = useState(false);
  const [speakerNames, setSpeakerNames]= useState(["Voice 1","Voice 2","Voice 3","Voice 4"]);
  const [manualQ,      setManualQ]     = useState("");
  const [length,       setLength]      = useState("normal");
  const [companyBrief, setCompanyBrief]= useState("");
  const [researching,  setResearching] = useState(false);
  const [researchError, setResearchError] = useState("");
  const [discreetMode, setDiscreetMode]= useState(false);
  const [pinned,       setPinned]      = useState([]);
  const [showPinned,   setShowPinned]  = useState(false);
  const [companyPresets, setCompanyPresets] = useState({});
  const [switchingCompany, setSwitchingCompany] = useState(false);
  const [showDebrief,  setShowDebrief] = useState(false);
  const [debriefText,  setDebriefText] = useState("");
  const [endingSession, setEndingSession] = useState(false);
  const [showQuickDebrief, setShowQuickDebrief] = useState(false);
  const [quickDebriefUsed, setQuickDebriefUsed] = useState(() => localStorage.getItem(QUICK_DEBRIEF_KEY) === "1");
  const quickDebriefResolveRef = useRef(null);
  const [endDebriefUsed, setEndDebriefUsed] = useState(() => localStorage.getItem(END_DEBRIEF_KEY) === "1");
  const [debriefPaywalled, setDebriefPaywalled] = useState(false);
  const [hasLicense, setHasLicense] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [notes, setNotes] = useState(() => localStorage.getItem(NOTES_KEY) || "");
  const notesRef = useRef(notes);
  useEffect(() => { notesRef.current = notes; localStorage.setItem(NOTES_KEY, notes); }, [notes]);

  const refreshCompanyPresets = useCallback(() => {
    invoke("list_company_presets").then(setCompanyPresets).catch(() => {});
  }, []);

  const applyCompanyPreset = async (name) => {
    const preset = companyPresets[name];
    if (!preset) return;
    setSwitchingCompany(true);
    try {
      const current = await invoke("get_settings");
      const merged = {
        ...current,
        company_name:    preset.company_name,
        job_description: preset.job_description,
        company_brief:   preset.company_brief,
        default_mode:    preset.default_mode,
        mode_prompts:    { ...current.mode_prompts, ...preset.mode_prompts },
      };
      await invoke("save_settings", { settings: merged });
      await invoke("restart_sidecar");
      setCompanyBrief(preset.company_brief || "");
    } finally {
      setSwitchingCompany(false);
    }
  };

  const fontSize = FONT_SIZES[fontIdx];
  const opacity  = OPACITY_STEPS[opacityIdx];

  // keep pausedRef in sync
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  // ── websocket ─────────────────────────────────────────────────────────────
  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) return;
    const sock = new WebSocket(WS_URL);
    ws.current = sock;
    setWsState("connecting");
    sock.onopen  = () => setWsState("open");
    sock.onclose = () => {
      setWsState("closed");
      setStatus("reconnecting");
      setResearching(false);
      reconnectTimer.current = setTimeout(connect, 2000);
    };
    sock.onmessage = ({ data }) => {
      const ev = JSON.parse(data);
      switch (ev.type) {
        case "status":
          setStatus(ev.state);
          setPaused(ev.state === "paused");
          break;
        case "mode": setMode(ev.mode); break;
        case "web":    setWebEnabled(ev.enabled); break;
        case "answers": setAnswersEnabled(ev.enabled); break;
        case "length": setLength(ev.length); break;
        case "research_done":
          setCompanyBrief(ev.brief || "");
          setResearchError(ev.error ? "Couldn't research that company — web search is unavailable right now. Try again in a moment." : "");
          setResearching(false);
          break;
        case "confidence": setConfidence(ev.score); break;
        case "answer_token":
          setAnswer(a => a + ev.token);
          requestAnimationFrame(() => ansRef.current?.scrollTo(0, 9999));
          break;
        case "answer_end": break;
        case "history":
          setAnswer(ev.answer ?? "");
          setPos(ev.pos); setTotal(ev.total);
          setConfidence(0); // clear on history nav
          break;
        case "transcript":
          setTxLines(prev => {
            const next = [...prev, { speaker: ev.speaker, text: ev.text, isQuestion: ev.is_question }];
            return next.slice(-MAX_TX_LINES);
          });
          requestAnimationFrame(() => txRef.current?.scrollTo(0, 9999));
          break;
        case "session_end":
          clearTimeout(endSessionTimer.current);
          setEndingSession(false);
          setDebriefText(appendNotesSection(ev.debrief || ev.summary || "", notesRef.current));
          setShowDebrief(true);
          if (ev.debrief) {
            localStorage.setItem(END_DEBRIEF_KEY, "1");
            setEndDebriefUsed(true);
          }
          break;
        case "quick_debrief_result":
          clearTimeout(quickDebriefTimer.current);
          // guard: if the 30s timeout already fired (ref cleared) or a retry replaced it,
          // a late/stale response must not silently consume the user's one free use
          if (quickDebriefResolveRef.current) {
            quickDebriefResolveRef.current({ text: appendNotesSection(ev.debrief || "", notesRef.current) });
            quickDebriefResolveRef.current = null;
            localStorage.setItem(QUICK_DEBRIEF_KEY, "1");
            setQuickDebriefUsed(true);
          }
          break;
      }
    };
  }, []);

  useEffect(() => { connect(); return () => { clearTimeout(reconnectTimer.current); clearTimeout(endSessionTimer.current); clearTimeout(quickDebriefTimer.current); }; }, [connect]);

  useEffect(() => {
    invoke("get_settings").then(s => {
      if (s.speaker_names?.length) setSpeakerNames(s.speaker_names);
      setHasLicense(!!s.license_key?.trim());
    }).catch(() => {});
  }, []);

  useEffect(() => { refreshCompanyPresets(); }, [refreshCompanyPresets]);

  // ── commands ──────────────────────────────────────────────────────────────
  const send        = obj => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify(obj));
  const togglePause = ()  => send({ cmd: pausedRef.current ? "resume" : "pause" });
  const cycleMode   = ()  => send({ cmd: "cycle_mode" });
  const toggleWeb   = ()  => send({ cmd: "toggle_web" });
  const toggleAnswers = () => send({ cmd: "toggle_answers" });
  const regenerate  = ()  => { setAnswer(""); setConfidence(0); send({ cmd: "regenerate" }); };
  const clear       = ()  => { setAnswer(""); setConfidence(0); send({ cmd: "clear" }); };
  const nav         = d   => send({ cmd: "nav", delta: d });
  const LENGTHS = ["brief", "normal", "detailed"];
  const cycleLength = () => {
    const next = LENGTHS[(LENGTHS.indexOf(length) + 1) % LENGTHS.length];
    send({ cmd: "set_length", length: next });
  };
  const submitAsk   = ()  => {
    const q = manualQ.trim();
    if (!q) return;
    setAnswer(""); setConfidence(0);
    send({ cmd: "ask", question: q });
    setManualQ("");
  };

  // ── keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = e => {
      if (showSettings || showHistory || showNotes) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "/") { e.preventDefault(); askRef.current?.focus(); return; }
      if (e.key === "p") togglePause();
      if (e.key === "m") cycleMode();
      if (e.key === "w") toggleWeb();
      if (e.key === "a") toggleAnswers();
      if (e.key === "n") setShowNotes(true);
      if (e.key === "l") cycleLength();
      if (e.key === "r") regenerate();
      if (e.key === "c") clear();
      if (e.key === "[") nav(-1);
      if (e.key === "]") nav(+1);
      if (e.key === "+" || e.key === "=") setFontIdx(i => Math.min(i+1, FONT_SIZES.length-1));
      if (e.key === "-") setFontIdx(i => Math.max(i-1, 0));
      if (e.key === "Escape") { setShowSettings(false); setShowHistory(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── window controls ───────────────────────────────────────────────────────
  useEffect(() => { getCurrentWindow().isMaximized().then(setIsMaximized); }, []);
  const winMinimize = () => getCurrentWindow().minimize();
  const winMaximize = () => { getCurrentWindow().toggleMaximize(); setIsMaximized(m => !m); };
  const winClose    = () => getCurrentWindow().close(); // hides to tray (Rust handler)
  const runQuickDebrief = (qaText, callback) => {
    if (wsState !== "open") { callback({ error: "Not connected — check your connection and try again." }); return; }
    quickDebriefResolveRef.current = callback;
    send({ cmd: "quick_debrief", text: qaText });
    clearTimeout(quickDebriefTimer.current);
    quickDebriefTimer.current = setTimeout(() => {
      quickDebriefResolveRef.current?.({ error: "Timed out waiting for a response — try again." });
      quickDebriefResolveRef.current = null;
    }, 30000);
  };

  const endSession  = () => {
    if (wsState !== "open") return; // nothing to end if we're not connected
    if (!hasLicense && endDebriefUsed) {
      setDebriefPaywalled(true); setShowDebrief(true);
      return;
    }
    setDebriefPaywalled(false);
    setEndingSession(true); setDebriefText(""); setShowDebrief(true);
    send({ cmd: "end_session" });
    // safety net: don't leave the button/modal stuck forever if the sidecar never replies
    clearTimeout(endSessionTimer.current);
    endSessionTimer.current = setTimeout(() => {
      setEndingSession(false);
      setDebriefText(t => t || "[timed out waiting for the sidecar — try again]");
    }, 30000);
  };

  // ── discreet mode ─────────────────────────────────────────────────────────
  const toggleDiscreet = async () => {
    const next = !discreetMode;
    setDiscreetMode(next);
    const size = next ? DISCREET_SIZE : FULL_SIZE;
    await getCurrentWindow().setSize(new LogicalSize(size.width, size.height));
  };

  // ── copy ──────────────────────────────────────────────────────────────────
  const copyAnswer = async () => {
    if (!answer) return;
    await writeText(answer);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  // ── pin answer ────────────────────────────────────────────────────────────
  const [justPinned, setJustPinned] = useState(false);
  const pinAnswer = () => {
    if (!answer) return;
    setPinned(p => [{ id: Date.now(), text: answer, mode, ts: new Date().toLocaleTimeString() }, ...p]);
    setJustPinned(true);
    setTimeout(() => setJustPinned(false), 1200);
  };
  const unpinAnswer = (id) => setPinned(p => p.filter(item => item.id !== id));

  // ── resizable divider ─────────────────────────────────────────────────────
  const onDividerMouseDown = e => {
    e.preventDefault();
    const startY  = e.clientY;
    const startH  = txHeight;
    const bodyH   = bodyRef.current?.clientHeight ?? 300;
    const onMove  = e => {
      const delta = e.clientY - startY;
      setTxHeight(Math.min(75, Math.max(10, startH + (delta / bodyH) * 100)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ── status colour ─────────────────────────────────────────────────────────
  const statusColor = {
    listening:"#5fb85f", answering:"#7fd1ff", searching:"#a855f7", reconnecting:"#d98b3a",
    connecting:"#888", paused:"#888", error:"#f05b5b",
  }[status] ?? "#888";

  if (discreetMode) {
    return (
      <div className="discreet-pill" onClick={toggleDiscreet} title="Click to expand">
        <div className="status-dot" style={{ background: statusColor }} />
        <span className="discreet-label">Heario</span>
      </div>
    );
  }

  return (
    <div className="overlay" style={{ opacity }}>

      {/* ── top bar (2 rows) ── */}
      <div className="topbar">
        <div className="topbar-row topbar-row1">
          <div className="status-dot" style={{ background: statusColor }} />
          <span className="status-text" style={{ color: statusColor }}>{status}</span>
          {total > 0 && (
            <div className="nav-row">
              <button className="nav-btn" onClick={() => nav(-1)} title="[ — older">‹</button>
              <span className="counter">{pos}/{total}</span>
              <button className="nav-btn" onClick={() => nav(+1)} title="] — newer">›</button>
            </div>
          )}
          <div className="spacer" />
          <div className="win-controls">
            <button className="wc-btn wc-min"   onClick={winMinimize} title="Minimise">–</button>
            <button className="wc-btn wc-max"   onClick={winMaximize} title={isMaximized?"Restore":"Maximise"}>{isMaximized?"❐":"□"}</button>
            <button className="wc-btn wc-close" onClick={winClose}    title="Hide to tray">✕</button>
          </div>
        </div>
        <div className="topbar-row topbar-row2">
          <button className={`pill-btn pause-btn${paused ? " paused" : ""}`}
            onClick={togglePause} title="p — pause/resume">
            {paused ? "▶ Play" : "⏸ Pause"}
          </button>
          <button className={`pill-btn web-btn${webEnabled ? " web-active" : ""}`}
            onClick={toggleWeb} title="w — toggle web search">
            🔍{webEnabled ? " Web On" : " Web"}
          </button>
          <button className={`pill-btn answers-btn${answersEnabled ? "" : " answers-off"}`}
            onClick={toggleAnswers} title="a — toggle AI answers (transcription always stays on)">
            {answersEnabled ? "💬 Answers" : "📝 Transcribe Only"}
          </button>
          <button className="pill-btn" onClick={cycleMode} title="m — cycle mode">
            {MODE_ICONS[mode]} {MODE_LABELS[mode] ?? mode}
          </button>
          {Object.keys(companyPresets).length > 0 && (
            <select className="company-select" value="" disabled={switchingCompany}
              onChange={e => { if (e.target.value) applyCompanyPreset(e.target.value); }}
              title="Quick-switch company preset">
              <option value="">{switchingCompany ? "Switching…" : "🏢 Company…"}</option>
              {Object.keys(companyPresets).sort().map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          )}
          <div className="spacer" />
          <button className="icon-btn" onClick={toggleDiscreet} title="Discreet mode">🕶</button>
          <button className="icon-btn" onClick={() => setShowPinned(true)} title="Pinned answers">
            📌{pinned.length > 0 && <span className="badge">{pinned.length}</span>}
          </button>
          <button className="icon-btn" onClick={() => setShowHistory(true)} title="Session history">🕐</button>
          <button className="icon-btn" onClick={endSession} disabled={endingSession} title="End Meeting — get a debrief, then start fresh for the next one">
            {endingSession ? "⏳" : "📝"}
          </button>
          <button className="icon-btn" onClick={() => setShowQuickDebrief(true)} title="Quick Debrief — free, no session needed">✍️</button>
          <button className="icon-btn" onClick={() => setShowNotes(true)} title="Take Notes — n (added to your next debrief)">
            📓{notes.trim() && <span className="badge">•</span>}
          </button>
          <button className="icon-btn settings-btn" onClick={() => setShowSettings(true)} title="Settings">⚙ Settings</button>
        </div>
      </div>

      {/* ── main body ── */}
      <div className="body" ref={bodyRef}>

        {/* transcript panel */}
        <div className="transcript-panel" ref={txRef} style={{ height: `${txHeight}%` }}>
          <div className="panel-label">transcript</div>
          {txLines.length === 0
            ? <span className="placeholder">Waiting for audio…</span>
            : txLines.map((l, i) => (
                <div key={i} className={`tx-line${l.isQuestion ? " tx-question" : ""}`}>
                  {l.speaker != null && <span className="tx-speaker">{speakerNames[l.speaker] ?? `Voice ${l.speaker + 1}`}</span>}
                  <span className="tx-text">{l.text}</span>
                </div>
              ))
          }
        </div>

        {/* drag divider */}
        <div className="divider" onMouseDown={onDividerMouseDown} title="Drag to resize" />

        {/* answer panel */}
        <div className="answer-panel" style={{ fontSize }}>
          <div className="panel-label-row">
            <span className="panel-label">answer</span>
            {confidence > 0 && (
              <div className="conf-bar" title={`Confidence: ${confidence}/5`}>
                {[1,2,3,4,5].map(n => (
                  <div key={n} className="conf-pip"
                    style={{ background: n <= confidence ? CONF_COLORS[confidence] : "var(--border)" }} />
                ))}
                <span className="conf-label">{confidence}/5</span>
              </div>
            )}
          </div>
          <div className="answer-body" ref={ansRef}>
            {answer || <span className="placeholder">Answer will appear here…</span>}
          </div>
        </div>

      </div>

      {/* ── manual question input ── */}
      <div className="ask-row">
        <input
          ref={askRef}
          className="ask-input"
          value={manualQ}
          onChange={e => setManualQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); submitAsk(); }
            if (e.key === "Escape") { askRef.current?.blur(); setManualQ(""); }
          }}
          placeholder="Ask something… (Enter to send)"
        />
        <button className="ask-btn" onClick={submitAsk} disabled={!manualQ.trim()}>
          Ask
        </button>
      </div>

      {/* ── action bar ── */}
      <div className="actions">
        <button className="action-btn regen" onClick={regenerate} title="r">↺ Regen</button>
        <button className="action-btn"       onClick={clear}      title="c">✕ Clear</button>
        <button className="action-btn copy"  onClick={copyAnswer}>
          {copied ? "✓ Copied" : "⧉ Copy"}
        </button>
        <button className="action-btn" onClick={pinAnswer} disabled={!answer} title="Pin this answer">
          {justPinned ? "✓ Pinned" : "📌 Pin"}
        </button>
        <div className="spacer" />
        <div className="ctrl-group length-group" title="Answer length (l)">
          {LENGTHS.map(l => (
            <button key={l} className={`ctrl-btn length-btn${length === l ? " active" : ""}`}
              onClick={() => send({ cmd: "set_length", length: l })}>
              {l[0].toUpperCase() + l.slice(1)}
            </button>
          ))}
        </div>
        <div className="ctrl-group" title="Font size (+ / -)">
          <button className="ctrl-btn" onClick={() => setFontIdx(i => Math.max(i-1, 0))}>A−</button>
          <button className="ctrl-btn" onClick={() => setFontIdx(i => Math.min(i+1, FONT_SIZES.length-1))}>A+</button>
        </div>
        <div className="ctrl-group opacity-group" title="Opacity">
          <span className="ctrl-label">opacity</span>
          <input type="range" min={0} max={OPACITY_STEPS.length-1}
            value={opacityIdx} onChange={e => setOpacityIdx(Number(e.target.value))}
            className="opacity-slider" />
        </div>
        {wsState === "closed" && <span className="ws-warn">⚠ offline</span>}
      </div>

      {/* ── modals ── */}
      {showSettings && <SettingsModal
        liveBrief={companyBrief}
        researching={researching}
        researchError={researchError}
        onResearch={name => { setResearchError(""); setResearching(true); send({ cmd: "research_company", name }); }}
        onClose={(saved) => {
          if (saved?.speaker_names) setSpeakerNames(saved.speaker_names);
          setHasLicense(!!saved?.license_key?.trim());
          setShowSettings(false);
          refreshCompanyPresets();
        }} />}
      {showHistory  && <HistoryModal  onClose={() => setShowHistory(false)} />}
      {showPinned   && <PinnedModal   pinned={pinned} onUnpin={unpinAnswer} onClose={() => setShowPinned(false)} />}
      {showDebrief  && <DebriefModal  text={debriefText} loading={endingSession} paywalled={debriefPaywalled} onClose={() => { setShowDebrief(false); setDebriefPaywalled(false); }} />}
      {showQuickDebrief && <QuickDebriefModal
        alreadyUsed={quickDebriefUsed}
        onGenerated={runQuickDebrief}
        onClose={() => setShowQuickDebrief(false)}
      />}
      {showNotes && <NotesModal notes={notes} onChange={setNotes} onClose={() => setShowNotes(false)} />}

    </div>
  );
}
