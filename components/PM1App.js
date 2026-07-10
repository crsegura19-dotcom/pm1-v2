"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import {
  IDENTITIES,
  buildProfile,
  addThread,
  touchThread,
  setThreadStatus,
  colorForThread,
  shouldSuggestResume,
  resumeSuggestionText,
  addMission,
  isMissionOverdue,
  resolveMission,
  extendMissionOnce,
  interpretInaction,
  maybeGenerateHypothesis,
  resolveHypothesis,
  dominantMechanismOf,
  startDecreeProgram,
  logDecreeCheckin,
  decreeProgramProgress,
  generateEvolutionReport,
  generatePatternMirror,
  updateFromParsed,
} from "../lib/pm1-engine";

// ============================================================================
// Subcomponentes
// ============================================================================

function ResetButton({ onConfirm }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div style={{ marginTop: 4 }}>
      {!confirming ? (
        <button style={styles.resetBtn} onClick={() => setConfirming(true)}>Resetear todo</button>
      ) : (
        <div style={styles.resetConfirm}>
          <span style={styles.resetConfirmText}>¿Seguro? Se perderán todos los combates.</span>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button style={styles.resetConfirmYes} onClick={() => { setConfirming(false); onConfirm(); }}>Sí, resetear</button>
            <button style={styles.resetConfirmNo} onClick={() => setConfirming(false)}>Cancelar</button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusDot({ status, stale }) {
  let color = "#4ade80";
  if (status === "paused") color = "#666";
  else if (status === "completed") color = "#60a5fa";
  else if (stale) color = "#f59e0b";
  return <span style={{ ...styles.statusDot, background: color }} />;
}

// ============================================================================
// APP PRINCIPAL
// ============================================================================

export default function PM1App() {
  const [view, setView] = useState("map"); // map | chat | profile
  const [profile, setProfile] = useState(buildProfile);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [newThreadTitle, setNewThreadTitle] = useState("");
  const [commitStep, setCommitStep] = useState(null); // { actionText }
  const [commitTime, setCommitTime] = useState("");
  const [commitObstacle, setCommitObstacle] = useState("");
  const [confrontMission, setConfrontMission] = useState(null); // { threadId, mission }
  const [dismissedResume, setDismissedResume] = useState({});
  const [evolutionOpenThreadId, setEvolutionOpenThreadId] = useState(null);
  const messagesEndRef = useRef(null);

  // ---- carga inicial ----
  useEffect(() => {
    try {
      const saved = localStorage.getItem("pm1_profile_v2");
      if (saved) {
        const parsed = JSON.parse(saved);
        setProfile(parsed);
        checkForOverdue(parsed);
      }
    } catch {}
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [view, profile.activeThreadId, loading]);

  function persist(p) {
    setProfile(p);
    try { localStorage.setItem("pm1_profile_v2", JSON.stringify(p)); } catch {}
  }

  function checkForOverdue(p) {
    for (const tid of Object.keys(p.threads)) {
      const t = p.threads[tid];
      const pending = t.missions.find((m) => m.executed === null);
      if (pending && isMissionOverdue(pending)) {
        setConfrontMission({ threadId: tid, mission: pending });
        return;
      }
    }
  }

  const activeThread = profile.activeThreadId ? profile.threads[profile.activeThreadId] : null;

  // ============================================================================
  // MAPA DE COMBATES
  // ============================================================================
  function handleCreateThread() {
    if (!newThreadTitle.trim()) return;
    const next = addThread(profile, newThreadTitle.trim());
    persist(next);
    setNewThreadTitle("");
    setView("chat");
  }

  function openThread(threadId) {
    const next = touchThread(profile, threadId);
    persist({ ...next, activeThreadId: threadId });
    setView("chat");
    const t = next.threads[threadId];
    const pending = t.missions.find((m) => m.executed === null);
    if (pending && isMissionOverdue(pending)) setConfrontMission({ threadId, mission: pending });
  }

  function toggleThreadStatus(threadId, current) {
    const nextStatus = current === "active" ? "paused" : "active";
    persist(setThreadStatus(profile, threadId, nextStatus));
  }

  // ============================================================================
  // CHAT
  // ============================================================================
  async function sendMessage() {
    if (!input.trim() || loading || !activeThread) return;
    const userMsg = { role: "user", content: input.trim() };
    const threadWithMsg = { ...activeThread, messages: [...activeThread.messages, userMsg] };
    let next = { ...profile, threads: { ...profile.threads, [activeThread.id]: threadWithMsg } };
    persist(next);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: threadWithMsg.messages, profile: next, thread: threadWithMsg }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const { parsed } = data;

      const hasPendingMission = threadWithMsg.missions.some((m) => m.executed === null);

      const assistantMsg = {
        role: "assistant",
        content: parsed.text,
        mechanism: parsed.mechanism,
        evasion: parsed.evasion,
        lesson: parsed.lesson,
        proposedCombat: !hasPendingMission ? parsed.combat : null,
      };

      const threadWithReply = { ...threadWithMsg, messages: [...threadWithMsg.messages, assistantMsg] };
      next = { ...next, threads: { ...next.threads, [activeThread.id]: threadWithReply } };
      next = updateFromParsed(next, activeThread.id, parsed);
      persist(next);
    } catch (err) {
      const errMsg = { role: "assistant", content: "Error de conexión. Inténtalo de nuevo." };
      const threadWithErr = { ...threadWithMsg, messages: [...threadWithMsg.messages, errMsg] };
      persist({ ...next, threads: { ...next.threads, [activeThread.id]: threadWithErr } });
    }
    setLoading(false);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  // ============================================================================
  // COMPROMISO (hora + obstáculo) — antes de que una propuesta cuente como misión
  // ============================================================================
  function openCommitStep(actionText) {
    setCommitStep({ actionText });
    setCommitTime("");
    setCommitObstacle("");
  }

  function confirmCommitment() {
    if (!commitStep || !commitTime.trim() || !commitObstacle.trim() || !activeThread) return;
    const next = addMission(profile, activeThread.id, commitStep.actionText, commitTime.trim(), commitObstacle.trim());
    persist(next);
    setCommitStep(null);
    setCommitTime("");
    setCommitObstacle("");
  }

  // ============================================================================
  // RESOLUCIÓN DE MISIÓN (desde la barra normal o desde la confrontación)
  // ============================================================================
  function resolveActiveMission(threadId, missionId, executed) {
    let next = resolveMission(profile, threadId, missionId, executed);
    let thread = next.threads[threadId];

    if (!executed) {
      const reflection = interpretInaction(thread);
      thread = maybeGenerateHypothesis(thread);
      const sysMsg = { role: "system-reflection", content: reflection };
      thread = { ...thread, messages: [...thread.messages, sysMsg] };
      next = { ...next, threads: { ...next.threads, [threadId]: thread } };
    }

    persist(next);
    setConfrontMission(null);
  }

  function handleExtend(threadId, missionId) {
    const next = extendMissionOnce(profile, threadId, missionId);
    // damos margen hasta el final del día de hoy
    const thread = next.threads[threadId];
    const missions = thread.missions.map((m) => (m.id === missionId ? { ...m, commitTime: "23:59" } : m));
    persist({ ...next, threads: { ...next.threads, [threadId]: { ...thread, missions } } });
    setConfrontMission(null);
  }

  function handleHypothesisAnswer(threadId, confirmed) {
    persist(resolveHypothesis(profile, threadId, confirmed));
  }

  // ============================================================================
  // DECRETOS
  // ============================================================================
  function handleStartDecrees() {
    if (!activeThread) return;
    persist(startDecreeProgram(profile, activeThread.id));
  }

  function handleDecreeCheckin(programId, slot) {
    if (!activeThread) return;
    persist(logDecreeCheckin(profile, activeThread.id, programId, slot));
  }

  // ============================================================================
  // RESET
  // ============================================================================
  function resetAll() {
    persist(buildProfile());
    setConfrontMission(null);
    setCommitStep(null);
    setView("map");
  }

  const identity = profile.dominantIdentity ? IDENTITIES[profile.dominantIdentity] : null;
  const mirror = useMemo(() => generatePatternMirror(profile), [profile]);
  const threadList = profile.threadOrder.map((id) => profile.threads[id]).filter(Boolean).reverse();
  const pendingMissionInThread = activeThread ? activeThread.missions.find((m) => m.executed === null) : null;
  const activeDecreePrograms = activeThread ? activeThread.decreePrograms : [];

  // ==========================================================================
  // RENDER — PANTALLA DE CONFRONTACIÓN (bloqueante, tiene prioridad sobre todo)
  // ==========================================================================
  if (confrontMission) {
    const { threadId, mission } = confrontMission;
    const thread = profile.threads[threadId];
    return (
      <div style={styles.root}>
        <div style={styles.confrontOverlay}>
          <span style={styles.confrontLabel}>PENDIENTE SIN RESOLVER</span>
          <h2 style={styles.confrontTitle}>"{thread?.title}"</h2>
          <p style={styles.confrontAction}>{mission.action}</p>
          <p style={styles.confrontDetail}>
            Dijiste que lo harías a las <b>{mission.commitTime}</b>, y que{" "}
            <b>"{mission.obstacle}"</b> no te lo iba a impedir.
          </p>
          <p style={styles.confrontQuestion}>¿Qué pasó?</p>
          <div style={styles.confrontBtns}>
            <button style={{ ...styles.combatBtn, ...styles.combatBtnYes }} onClick={() => resolveActiveMission(threadId, mission.id, true)}>Sí, lo hice</button>
            <button style={{ ...styles.combatBtn, ...styles.combatBtnNo }} onClick={() => resolveActiveMission(threadId, mission.id, false)}>No pude</button>
          </div>
          {!mission.extensionUsed && (
            <button style={styles.confrontExtend} onClick={() => handleExtend(threadId, mission.id)}>
              Necesito hasta el final del día (solo una vez)
            </button>
          )}
        </div>
      </div>
    );
  }

  // ==========================================================================
  // RENDER — MODAL DE COMPROMISO
  // ==========================================================================
  const commitModal = commitStep && (
    <div style={styles.commitOverlay}>
      <div style={styles.commitCard}>
        <span style={styles.confrontLabel}>ANTES DE QUE CUENTE COMO COMBATE</span>
        <p style={styles.commitAction}>{commitStep.actionText}</p>
        <label style={styles.commitLabel}>¿A qué hora exacta lo vas a hacer?</label>
        <input style={styles.commitInput} type="time" value={commitTime} onChange={(e) => setCommitTime(e.target.value)} />
        <label style={styles.commitLabel}>¿Qué es lo primero que te va a dar excusa para no hacerlo?</label>
        <textarea style={styles.commitTextarea} rows={2} value={commitObstacle} onChange={(e) => setCommitObstacle(e.target.value)} placeholder="Sé específico. Nómbralo ahora para que pierda fuerza después." />
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button style={{ ...styles.combatBtn, ...styles.combatBtnYes, opacity: commitTime && commitObstacle.trim() ? 1 : 0.4 }} disabled={!commitTime || !commitObstacle.trim()} onClick={confirmCommitment}>Confirmar compromiso</button>
          <button style={{ ...styles.combatBtn, ...styles.combatBtnNo }} onClick={() => setCommitStep(null)}>Todavía no</button>
        </div>
      </div>
    </div>
  );

  // ==========================================================================
  // RENDER — MAPA DE COMBATES
  // ==========================================================================
  if (view === "map") {
    return (
      <div style={styles.root}>
        {commitModal}
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <span style={styles.logo}>PM1</span>
            <span style={styles.logoSub}>PRIMER MOVIMIENTO</span>
          </div>
          <div style={styles.headerNav}>
            <button style={{ ...styles.navBtn, ...styles.navBtnActive }}>Mapa</button>
            <button style={styles.navBtn} onClick={() => setView("profile")}>Perfil</button>
          </div>
        </div>

        <div style={styles.mapContainer}>
          <p style={styles.mapIntro}>Mis Combates</p>

          <div style={styles.newThreadRow}>
            <input
              style={styles.newThreadInput}
              placeholder="Ej. Procrastinación, Ansiedad social, Alcohol..."
              value={newThreadTitle}
              onChange={(e) => setNewThreadTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateThread()}
            />
            <button style={styles.newThreadBtn} onClick={handleCreateThread}>+ Abrir combate</button>
          </div>

          {threadList.length === 0 && (
            <div style={styles.emptyState}>
              <div style={styles.emptyIcon}>⚔</div>
              <p style={styles.emptyTitle}>Ningún combate abierto todavía</p>
              <p style={styles.emptyText}>Nombra lo que quieres y no puedes hacer. Ese es tu primer combate.</p>
            </div>
          )}

          {threadList.map((t) => {
            const stale = shouldSuggestResume(t);
            const pending = t.missions.find((m) => m.executed === null);
            const executedCount = t.missions.filter((m) => m.executed).length;
            return (
              <div key={t.id} style={styles.threadCard} onClick={() => openThread(t.id)}>
                <div style={styles.threadCardTop}>
                  <div style={styles.threadCardTitleRow}>
                    <StatusDot status={t.status} stale={stale} />
                    <span style={styles.threadCardTitle}>{t.title}</span>
                  </div>
                  <button
                    style={styles.threadPauseBtn}
                    onClick={(e) => { e.stopPropagation(); toggleThreadStatus(t.id, t.status); }}
                  >
                    {t.status === "paused" ? "reanudar" : "pausar"}
                  </button>
                </div>
                <p style={styles.threadCardMeta}>
                  {t.status === "paused" ? "Pausado" : pending ? "Misión pendiente" : `${executedCount} movimiento${executedCount === 1 ? "" : "s"} ejecutado${executedCount === 1 ? "" : "s"}`}
                  {stale ? " · lleva días sin tocarse" : ""}
                </p>
                <div style={styles.threadProgressTrack}>
                  <div style={{ ...styles.threadProgressFill, width: `${t.progress}%`, background: colorForThread(t) }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ==========================================================================
  // RENDER — PERFIL (global)
  // ==========================================================================
  if (view === "profile") {
    return (
      <div style={styles.root}>
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <span style={styles.logo}>PM1</span>
            <span style={styles.logoSub}>PRIMER MOVIMIENTO</span>
          </div>
          <div style={styles.headerNav}>
            <button style={styles.navBtn} onClick={() => setView("map")}>Mapa</button>
            <button style={{ ...styles.navBtn, ...styles.navBtnActive }}>Perfil</button>
          </div>
        </div>

        <div style={styles.profileContainer}>
          <div style={styles.identityCard}>
            <span style={styles.identityLabel}>IDENTIDAD OBSERVADA</span>
            {identity ? (
              <>
                <h2 style={styles.identityName}>{identity.label}</h2>
                <p style={styles.identityDesc}>{identity.description}</p>
              </>
            ) : (
              <p style={styles.identityEmpty}>Aún sin datos suficientes para detectar un patrón.</p>
            )}
          </div>

          <div style={styles.statsRow}>
            {[
              { num: profile.movements, label: "Movimientos" },
              { num: profile.streak, label: "Racha" },
              { num: threadList.length, label: "Combates" },
              { num: profile.resistanceLevel, label: "Resistencia" },
            ].map(({ num, label }) => (
              <div key={label} style={styles.statCard}>
                <span style={styles.statNum}>{num}</span>
                <span style={styles.statLabel}>{label}</span>
              </div>
            ))}
          </div>

          <div style={styles.mirrorCard}>
            <span style={styles.sectionLabel}>ESPEJO DE PATRÓN</span>
            <p style={styles.mirrorText}>{mirror.text}</p>
          </div>

          {profile.wins.length > 0 && (
            <div style={styles.section}>
              <span style={styles.sectionLabel}>REGISTRO DE VICTORIAS</span>
              {profile.wins.slice(-8).reverse().map((w) => (
                <div key={w.id} style={styles.winItem}>
                  <span style={styles.winIcon}>✓</span>
                  <span style={styles.winText}>{w.text}</span>
                </div>
              ))}
            </div>
          )}

          {threadList.length > 0 && (
            <div style={styles.section}>
              <span style={styles.sectionLabel}>EVOLUCIÓN POR COMBATE</span>
              {threadList.map((t) => {
                const open = evolutionOpenThreadId === t.id;
                const report = open ? generateEvolutionReport(t) : null;
                return (
                  <div key={t.id} style={styles.evolutionRow}>
                    <button style={styles.evolutionToggle} onClick={() => setEvolutionOpenThreadId(open ? null : t.id)}>
                      {open ? "▾" : "▸"} {t.title}
                    </button>
                    {open && report && (
                      report.ready ? (
                        <div style={styles.evolutionCard}>
                          <p style={styles.evolutionSpan}>Últimos {report.spanDays} días</p>
                          <p style={styles.evolutionSubhead}>Antes</p>
                          {report.before.map((l, i) => <p key={i} style={styles.evolutionLine}>— {l}</p>)}
                          <p style={styles.evolutionSubhead}>Ahora</p>
                          {report.after.map((l, i) => <p key={i} style={styles.evolutionLine}>— {l}</p>)}
                          <p style={styles.evolutionClosing}>{report.closing}</p>
                        </div>
                      ) : (
                        <p style={styles.evolutionEmpty}>{report.text}</p>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {(threadList.length > 0 || profile.wins.length > 0) && <ResetButton onConfirm={resetAll} />}
        </div>
      </div>
    );
  }

  // ==========================================================================
  // RENDER — CHAT DE UN COMBATE
  // ==========================================================================
  if (!activeThread) {
    setView("map");
    return null;
  }

  const stale = shouldSuggestResume(activeThread);
  const showResumeBanner = stale && !dismissedResume[activeThread.id];

  return (
    <div style={styles.root}>
      {commitModal}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <button style={styles.backBtn} onClick={() => setView("map")}>←</button>
          <span style={{ ...styles.threadHeaderTitle, color: colorForThread(activeThread) }}>{activeThread.title}</span>
        </div>
        <div style={styles.headerNav}>
          <button style={styles.navBtn} onClick={() => setView("profile")}>Perfil</button>
        </div>
      </div>

      <div style={styles.chatContainer}>
        <div style={styles.messages}>
          {showResumeBanner && (
            <div style={styles.resumeBanner}>
              <p style={styles.resumeBannerText}>{resumeSuggestionText(activeThread)}</p>
              <div style={styles.resumeBannerBtns}>
                <button style={styles.resumeBtnSmall} onClick={() => setDismissedResume((d) => ({ ...d, [activeThread.id]: true }))}>Ya lo tengo resuelto</button>
                <button style={styles.resumeBtnSmall} onClick={() => setDismissedResume((d) => ({ ...d, [activeThread.id]: true }))}>Quiero retomarlo</button>
                <button style={styles.resumeBtnSmall} onClick={() => { toggleThreadStatus(activeThread.id, "active"); setDismissedResume((d) => ({ ...d, [activeThread.id]: true })); }}>Prefiero dejarlo por ahora</button>
              </div>
            </div>
          )}

          {activeThread.hypothesis && activeThread.hypothesis.resolved === null && (
            <div style={styles.hypothesisBanner}>
              <span style={styles.hypothesisLabel}>HIPÓTESIS</span>
              <p style={styles.hypothesisText}>{activeThread.hypothesis.text}</p>
              <div style={styles.resumeBannerBtns}>
                <button style={styles.resumeBtnSmall} onClick={() => handleHypothesisAnswer(activeThread.id, true)}>Creo que sí es eso</button>
                <button style={styles.resumeBtnSmall} onClick={() => handleHypothesisAnswer(activeThread.id, false)}>No creo que sea eso</button>
              </div>
            </div>
          )}

          {activeThread.messages.length === 0 && (
            <div style={styles.emptyState}>
              <div style={styles.emptyIcon}>⚔</div>
              <p style={styles.emptyTitle}>¿Qué es eso que quieres y no puedes hacer?</p>
              <p style={styles.emptyText}>Escríbelo como se te venga. Sin filtros, sin justificaciones. Solo lo que está pasando.</p>
            </div>
          )}

          {activeThread.messages.map((msg, i) => {
            if (msg.role === "system-reflection") {
              return (
                <div key={i} style={styles.reflectionRow}>
                  <span style={styles.reflectionText}>{msg.content}</span>
                </div>
              );
            }
            return (
              <div key={i} style={{ ...styles.msgRow, justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{ ...styles.bubble, ...(msg.role === "user" ? styles.bubbleUser : styles.bubbleAI) }}>
                  <p style={styles.bubbleText}>{msg.content}</p>
                  {msg.evasion && (
                    <div style={styles.evasionTag}>
                      <span style={styles.evasionTagLabel}>EVASIÓN DETECTADA</span>
                      <span style={styles.evasionTagText}>{msg.evasion}</span>
                    </div>
                  )}
                  {msg.lesson && (
                    <div style={styles.lessonTag}>
                      <span style={styles.lessonTagLabel}>LECCIÓN DE COMBATE</span>
                      <span style={styles.lessonTagText}>{msg.lesson}</span>
                    </div>
                  )}
                  {msg.proposedCombat && (
                    <div style={styles.combatTag}>
                      <span style={styles.combatTagLabel}>PRIMER COMBATE PROPUESTO</span>
                      <span style={styles.combatTagText}>{msg.proposedCombat}</span>
                      <button style={styles.commitBtn} onClick={() => openCommitStep(msg.proposedCombat)}>Comprometerme →</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {loading && (
            <div style={{ ...styles.msgRow, justifyContent: "flex-start" }}>
              <div style={{ ...styles.bubble, ...styles.bubbleAI }}>
                <div style={styles.typingDots}>
                  <span style={styles.dot} />
                  <span style={{ ...styles.dot, animationDelay: "0.2s" }} />
                  <span style={{ ...styles.dot, animationDelay: "0.4s" }} />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {pendingMissionInThread && (
          <div style={styles.combatBar}>
            <p style={styles.combatBarQuestion}>Comprometido para las {pendingMissionInThread.commitTime} — ¿lo ejecutaste?</p>
            <p style={styles.combatBarAction}>{pendingMissionInThread.action}</p>
            <div style={styles.combatBarBtns}>
              <button style={{ ...styles.combatBtn, ...styles.combatBtnYes }} onClick={() => resolveActiveMission(activeThread.id, pendingMissionInThread.id, true)}>Sí, lo hice</button>
              <button style={{ ...styles.combatBtn, ...styles.combatBtnNo }} onClick={() => resolveActiveMission(activeThread.id, pendingMissionInThread.id, false)}>No pude</button>
            </div>
          </div>
        )}

        {activeDecreePrograms.length > 0 && (
          <div style={styles.decreeBar}>
            <span style={styles.sectionLabel}>DECRETOS ACTIVOS</span>
            {activeDecreePrograms.map((p) => (
              <div key={p.id} style={styles.decreeProgramRow}>
                {p.texts.map((t, i) => <p key={i} style={styles.decreeText}>"{t}"</p>)}
                <div style={styles.decreeProgressTrack}>
                  <div style={{ ...styles.decreeProgressFill, width: `${decreeProgramProgress(p)}%` }} />
                </div>
                <div style={styles.resumeBannerBtns}>
                  <button style={styles.resumeBtnSmall} onClick={() => handleDecreeCheckin(p.id, "manana")}>Marcar mañana</button>
                  <button style={styles.resumeBtnSmall} onClick={() => handleDecreeCheckin(p.id, "noche")}>Marcar noche</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!pendingMissionInThread && activeDecreePrograms.length === 0 && activeThread.missions.some((m) => m.executed !== null) && (
          <div style={styles.decreeStartRow}>
            <button style={styles.decreeStartBtn} onClick={handleStartDecrees}>+ Empezar programa de decretos para este combate</button>
          </div>
        )}

        <div style={styles.inputArea}>
          <textarea style={styles.textarea} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} placeholder="Describe tu situación..." rows={2} />
          <button style={{ ...styles.sendBtn, opacity: loading || !input.trim() ? 0.4 : 1 }} onClick={sendMessage} disabled={loading || !input.trim()}>→</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// ESTILOS
// ============================================================================
const styles = {
  root: { fontFamily: "'Space Grotesk', sans-serif", background: "#0a0a0a", color: "#e8e8e8", height: "100vh", display: "flex", flexDirection: "column", maxWidth: 680, margin: "0 auto", border: "1px solid #1a1a1a", position: "relative" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #1a1a1a", background: "#0a0a0a", flexShrink: 0 },
  headerLeft: { display: "flex", alignItems: "center", gap: 10 },
  backBtn: { background: "none", border: "1px solid #222", color: "#888", width: 30, height: 30, borderRadius: 6, cursor: "pointer", fontSize: 14 },
  logo: { fontFamily: "'Space Mono', monospace", fontWeight: 700, fontSize: 22, color: "#c8f542", letterSpacing: "-1px" },
  logoSub: { fontFamily: "'Space Mono', monospace", fontSize: 9, color: "#333", letterSpacing: "3px", textTransform: "uppercase" },
  threadHeaderTitle: { fontSize: 16, fontWeight: 600 },
  headerNav: { display: "flex", gap: 4 },
  navBtn: { background: "none", border: "1px solid #222", color: "#555", padding: "6px 14px", borderRadius: 4, fontSize: 12, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif", letterSpacing: "0.5px" },
  navBtnActive: { background: "#141414", border: "1px solid #333", color: "#c8f542" },

  mapContainer: { flex: 1, overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: 12 },
  mapIntro: { fontFamily: "'Space Mono', monospace", fontSize: 11, color: "#444", letterSpacing: "2px", textTransform: "uppercase" },
  newThreadRow: { display: "flex", gap: 8, marginBottom: 4 },
  newThreadInput: { flex: 1, background: "#0f0f0f", border: "1px solid #222", borderRadius: 8, color: "#e8e8e8", fontSize: 13, padding: "10px 12px", fontFamily: "'Space Grotesk', sans-serif" },
  newThreadBtn: { background: "#c8f542", color: "#0a0a0a", border: "none", borderRadius: 8, padding: "0 16px", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" },
  threadCard: { padding: "16px 18px", background: "#0d0d0d", border: "1px solid #1a1a1a", borderRadius: 10, cursor: "pointer", display: "flex", flexDirection: "column", gap: 8 },
  threadCardTop: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  threadCardTitleRow: { display: "flex", alignItems: "center", gap: 8 },
  statusDot: { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 },
  threadCardTitle: { fontSize: 15, fontWeight: 600, color: "#e8e8e8" },
  threadPauseBtn: { background: "none", border: "1px solid #222", color: "#555", fontSize: 10, padding: "4px 8px", borderRadius: 4, cursor: "pointer", fontFamily: "'Space Mono', monospace" },
  threadCardMeta: { fontSize: 12, color: "#555" },
  threadProgressTrack: { height: 3, background: "#1a1a1a", borderRadius: 2, overflow: "hidden" },
  threadProgressFill: { height: "100%", borderRadius: 2, transition: "width 0.4s ease" },

  emptyState: { textAlign: "center", padding: "60px 20px", margin: "auto", maxWidth: 360 },
  emptyIcon: { fontSize: 40, marginBottom: 16, filter: "grayscale(1)", opacity: 0.4 },
  emptyTitle: { fontSize: 18, fontWeight: 600, color: "#888", marginBottom: 10 },
  emptyText: { fontSize: 13, color: "#444", lineHeight: 1.7 },

  chatContainer: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  messages: { flex: 1, overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: 12 },
  msgRow: { display: "flex", width: "100%" },
  bubble: { maxWidth: "78%", padding: "12px 16px", borderRadius: 10, lineHeight: 1.6 },
  bubbleUser: { background: "#141414", border: "1px solid #222", borderBottomRightRadius: 2 },
  bubbleAI: { background: "#0f0f0f", border: "1px solid #1e1e1e", borderBottomLeftRadius: 2 },
  bubbleText: { fontSize: 14, color: "#d4d4d4", whiteSpace: "pre-wrap", lineHeight: 1.7 },

  combatTag: { marginTop: 12, padding: "10px 12px", background: "rgba(200,245,66,0.06)", border: "1px solid rgba(200,245,66,0.2)", borderRadius: 6, display: "flex", flexDirection: "column", gap: 8 },
  combatTagLabel: { display: "block", fontFamily: "'Space Mono', monospace", fontSize: 9, color: "#c8f542", letterSpacing: "2px" },
  combatTagText: { fontSize: 13, color: "#c8f542", fontWeight: 500 },
  commitBtn: { alignSelf: "flex-start", background: "#c8f542", color: "#0a0a0a", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" },

  evasionTag: { marginTop: 8, padding: "8px 12px", background: "rgba(248,113,113,0.05)", border: "1px solid rgba(248,113,113,0.15)", borderRadius: 6 },
  evasionTagLabel: { display: "block", fontFamily: "'Space Mono', monospace", fontSize: 9, color: "#f87171", letterSpacing: "2px", marginBottom: 4 },
  evasionTagText: { fontSize: 12, color: "#f87171", opacity: 0.8 },

  lessonTag: { marginTop: 8, padding: "10px 12px", background: "rgba(96,165,250,0.06)", border: "1px solid rgba(96,165,250,0.2)", borderRadius: 6 },
  lessonTagLabel: { display: "block", fontFamily: "'Space Mono', monospace", fontSize: 9, color: "#60a5fa", letterSpacing: "2px", marginBottom: 4 },
  lessonTagText: { fontSize: 13, color: "#93c5fd", fontStyle: "italic" },

  reflectionRow: { display: "flex", justifyContent: "center", padding: "4px 20px" },
  reflectionText: { fontSize: 12, color: "#666", fontStyle: "italic", textAlign: "center", maxWidth: "85%", lineHeight: 1.6 },

  typingDots: { display: "flex", gap: 5, padding: "4px 2px", alignItems: "center" },
  dot: { width: 6, height: 6, borderRadius: "50%", background: "#333", animation: "pulse 1.2s ease-in-out infinite" },

  resumeBanner: { margin: "0 0 4px", padding: "12px 14px", background: "#0d0d0d", border: "1px solid #2a2410", borderRadius: 8 },
  resumeBannerText: { fontSize: 12.5, color: "#c9b878", lineHeight: 1.6, marginBottom: 10 },
  resumeBannerBtns: { display: "flex", gap: 6, flexWrap: "wrap" },
  resumeBtnSmall: { background: "none", border: "1px solid #333", color: "#999", fontSize: 11, padding: "6px 10px", borderRadius: 5, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" },

  hypothesisBanner: { margin: "0 0 4px", padding: "12px 14px", background: "#0d0d0d", border: "1px solid rgba(192,132,252,0.3)", borderRadius: 8 },
  hypothesisLabel: { fontFamily: "'Space Mono', monospace", fontSize: 9, color: "#c084fc", letterSpacing: "2px" },
  hypothesisText: { fontSize: 12.5, color: "#d8b4fe", lineHeight: 1.6, margin: "6px 0 10px" },

  combatBar: { margin: "0 16px 12px", padding: "14px 16px", background: "#0d0d0d", border: "1px solid rgba(200,245,66,0.25)", borderRadius: 8, flexShrink: 0 },
  combatBarQuestion: { fontSize: 11, color: "#666", letterSpacing: "1px", textTransform: "uppercase", fontFamily: "'Space Mono', monospace", marginBottom: 6 },
  combatBarAction: { fontSize: 14, color: "#c8f542", fontWeight: 500, marginBottom: 12, lineHeight: 1.5 },
  combatBarBtns: { display: "flex", gap: 8 },
  combatBtn: { flex: 1, padding: "9px", border: "none", borderRadius: 5, fontSize: 13, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif", fontWeight: 500 },
  combatBtnYes: { background: "rgba(74,222,128,0.15)", color: "#4ade80", border: "1px solid rgba(74,222,128,0.25)" },
  combatBtnNo: { background: "rgba(248,113,113,0.1)", color: "#f87171", border: "1px solid rgba(248,113,113,0.2)" },

  decreeBar: { margin: "0 16px 12px", padding: "14px 16px", background: "#0d0d0d", border: "1px solid rgba(96,165,250,0.2)", borderRadius: 8, flexShrink: 0, display: "flex", flexDirection: "column", gap: 8 },
  decreeProgramRow: { display: "flex", flexDirection: "column", gap: 6 },
  decreeText: { fontSize: 12.5, color: "#93c5fd", fontStyle: "italic" },
  decreeProgressTrack: { height: 3, background: "#1a1a1a", borderRadius: 2, overflow: "hidden", marginTop: 4 },
  decreeProgressFill: { height: "100%", background: "#60a5fa", borderRadius: 2 },
  decreeStartRow: { padding: "0 16px 12px" },
  decreeStartBtn: { width: "100%", background: "none", border: "1px dashed #333", color: "#666", padding: "10px", borderRadius: 8, fontSize: 12, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" },

  inputArea: { display: "flex", alignItems: "flex-end", gap: 10, padding: "12px 16px 16px", borderTop: "1px solid #141414", flexShrink: 0 },
  textarea: { flex: 1, background: "#0f0f0f", border: "1px solid #222", borderRadius: 8, color: "#e8e8e8", fontSize: 14, padding: "10px 14px", resize: "none", lineHeight: 1.6, fontFamily: "'Space Grotesk', sans-serif" },
  sendBtn: { background: "#c8f542", color: "#0a0a0a", border: "none", borderRadius: 8, width: 40, height: 40, fontSize: 20, cursor: "pointer", fontWeight: 700, flexShrink: 0 },

  confrontOverlay: { position: "absolute", inset: 0, background: "#0a0a0a", display: "flex", flexDirection: "column", justifyContent: "center", padding: "32px 28px", gap: 6, zIndex: 10 },
  confrontLabel: { fontFamily: "'Space Mono', monospace", fontSize: 10, color: "#f87171", letterSpacing: "3px" },
  confrontTitle: { fontSize: 18, color: "#888", margin: "8px 0 4px", fontWeight: 500 },
  confrontAction: { fontSize: 20, color: "#e8e8e8", fontWeight: 600, lineHeight: 1.4, margin: "6px 0 16px" },
  confrontDetail: { fontSize: 14, color: "#999", lineHeight: 1.7, marginBottom: 18 },
  confrontQuestion: { fontSize: 16, color: "#c8f542", fontWeight: 600, marginBottom: 16 },
  confrontBtns: { display: "flex", gap: 10 },
  confrontExtend: { marginTop: 16, background: "none", border: "1px solid #222", color: "#555", padding: "10px", borderRadius: 6, fontSize: 12, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" },

  commitOverlay: { position: "absolute", inset: 0, background: "rgba(10,10,10,0.92)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, zIndex: 9 },
  commitCard: { background: "#0d0d0d", border: "1px solid #222", borderRadius: 12, padding: "24px 22px", width: "100%", maxWidth: 420, display: "flex", flexDirection: "column", gap: 4 },
  commitAction: { fontSize: 16, color: "#c8f542", fontWeight: 600, lineHeight: 1.5, margin: "10px 0 18px" },
  commitLabel: { fontSize: 12, color: "#888", marginTop: 12, marginBottom: 6 },
  commitInput: { background: "#0a0a0a", border: "1px solid #222", borderRadius: 6, color: "#e8e8e8", fontSize: 14, padding: "9px 12px", fontFamily: "'Space Grotesk', sans-serif" },
  commitTextarea: { background: "#0a0a0a", border: "1px solid #222", borderRadius: 6, color: "#e8e8e8", fontSize: 13, padding: "9px 12px", resize: "none", fontFamily: "'Space Grotesk', sans-serif", lineHeight: 1.5 },

  profileContainer: { flex: 1, overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: 16 },
  identityCard: { padding: "20px", background: "#0d0d0d", border: "1px solid #1e1e1e", borderRadius: 10 },
  identityLabel: { display: "block", fontFamily: "'Space Mono', monospace", fontSize: 9, color: "#444", letterSpacing: "3px", marginBottom: 10 },
  identityName: { fontSize: 22, fontWeight: 700, color: "#c8f542", marginBottom: 8, letterSpacing: "-0.5px" },
  identityDesc: { fontSize: 13, color: "#666", lineHeight: 1.6 },
  identityEmpty: { fontSize: 13, color: "#333", lineHeight: 1.6 },
  statsRow: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 },
  statCard: { padding: "14px 10px", background: "#0d0d0d", border: "1px solid #1a1a1a", borderRadius: 8, textAlign: "center", display: "flex", flexDirection: "column", gap: 4 },
  statNum: { fontFamily: "'Space Mono', monospace", fontSize: 24, fontWeight: 700, color: "#e8e8e8" },
  statLabel: { fontSize: 10, color: "#444", letterSpacing: "1px", textTransform: "uppercase" },

  mirrorCard: { padding: "20px", background: "#0d0d0d", border: "1px solid #2a2a1a", borderRadius: 10, display: "flex", flexDirection: "column", gap: 10 },
  mirrorText: { fontSize: 13.5, color: "#d4d4d4", lineHeight: 1.9, whiteSpace: "pre-line" },

  section: { padding: "18px 20px", background: "#0d0d0d", border: "1px solid #1a1a1a", borderRadius: 10, display: "flex", flexDirection: "column", gap: 12 },
  sectionLabel: { fontFamily: "'Space Mono', monospace", fontSize: 9, color: "#444", letterSpacing: "3px" },

  winItem: { display: "flex", gap: 10, alignItems: "flex-start" },
  winIcon: { color: "#4ade80", fontSize: 13, flexShrink: 0, marginTop: 1, fontFamily: "'Space Mono', monospace" },
  winText: { fontSize: 13, color: "#999", lineHeight: 1.5 },

  evolutionRow: { display: "flex", flexDirection: "column", gap: 8 },
  evolutionToggle: { background: "none", border: "none", color: "#999", fontSize: 13, textAlign: "left", cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif", padding: 0 },
  evolutionCard: { padding: "12px 14px", background: "#0a0a0a", border: "1px solid #1a1a1a", borderRadius: 8, display: "flex", flexDirection: "column", gap: 4 },
  evolutionSpan: { fontSize: 11, color: "#444", marginBottom: 6 },
  evolutionSubhead: { fontFamily: "'Space Mono', monospace", fontSize: 9, color: "#666", letterSpacing: "2px", marginTop: 8 },
  evolutionLine: { fontSize: 12.5, color: "#999", lineHeight: 1.6 },
  evolutionClosing: { fontSize: 13, color: "#c8f542", marginTop: 10, lineHeight: 1.6, fontStyle: "italic" },
  evolutionEmpty: { fontSize: 12, color: "#444", paddingLeft: 4 },

  resetBtn: { background: "none", border: "1px solid #1e1e1e", color: "#333", padding: "10px", borderRadius: 6, fontSize: 11, cursor: "pointer", fontFamily: "'Space Mono', monospace", letterSpacing: "1px", width: "100%" },
  resetConfirm: { padding: "14px 16px", background: "#0d0d0d", border: "1px solid #2a1a1a", borderRadius: 8 },
  resetConfirmText: { fontSize: 12, color: "#666" },
  resetConfirmYes: { flex: 1, padding: "8px", background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.2)", color: "#f87171", borderRadius: 5, fontSize: 12, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" },
  resetConfirmNo: { flex: 1, padding: "8px", background: "none", border: "1px solid #222", color: "#555", borderRadius: 5, fontSize: 12, cursor: "pointer", fontFamily: "'Space Grotesk', sans-serif" },
};
