"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Sparkles, X } from "lucide-react";
import { TattvaChat } from "./views/TattvaChat";

const SIZE = 56;
const MARGIN = 12;
const DRAG_THRESHOLD = 5;
const PANEL_W = 390;
const PANEL_H = 560;
const STORAGE_KEY = "advait.tattvaBubble";

interface Pos { x: number; y: number }

function clamp(pos: Pos): Pos {
  return {
    x: Math.min(Math.max(pos.x, MARGIN), Math.max(window.innerWidth - SIZE - MARGIN, MARGIN)),
    y: Math.min(Math.max(pos.y, MARGIN), Math.max(window.innerHeight - SIZE - MARGIN, MARGIN)),
  };
}

function loadPosition(): Pos {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Pos | null;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return clamp(saved);
  } catch {
    /* fall through to default */
  }
  return clamp({ x: window.innerWidth - SIZE - 28, y: window.innerHeight - SIZE - 28 });
}

/** A draggable TattvaAI launcher. A click opens a small chat beside it; dragging moves it, and the position is remembered. */
export function FloatingTattva({ onOpenFull }: { onOpenFull: () => void }) {
  const [pos, setPos] = useState<Pos | null>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [, setViewport] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);

  useEffect(() => {
    setPos(loadPosition());
    const onResize = () => {
      setPos((p) => (p ? clamp(p) : p));
      setViewport((n) => n + 1);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (!pos) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, originX: pos.x, originY: pos.y, moved: false };
  }, [pos]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    d.moved = true;
    setDragging(true);
    setPos(clamp({ x: d.originX + dx, y: d.originY + dy }));
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.moved) {
      setPos((p) => {
        if (p) localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
        return p;
      });
    } else {
      setMounted(true);
      setOpen((o) => !o);
    }
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setMounted(true);
      setOpen((o) => !o);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!pos) return null;

  const width = Math.min(PANEL_W, window.innerWidth - MARGIN * 2);
  const height = Math.min(PANEL_H, window.innerHeight - MARGIN * 2);
  const left = Math.min(Math.max(pos.x + SIZE - width, MARGIN), window.innerWidth - width - MARGIN);
  const above = pos.y - height - 10;
  const top = above >= MARGIN ? above : Math.min(pos.y + SIZE + 10, window.innerHeight - height - MARGIN);

  return (
    <>
      {mounted && (
        <section className="adv-fab-panel" style={{ left, top, width, height, display: open ? "flex" : "none" }} role="dialog" aria-label="TattvaAI quick chat">
          <header className="adv-fab-head">
            <span><Sparkles size={15} /> TattvaAI</span>
            <span className="adv-fab-actions">
              <button type="button" onClick={() => { setOpen(false); onOpenFull(); }} title="Open full screen" aria-label="Open full screen"><Maximize2 size={14} /></button>
              <button type="button" onClick={() => setOpen(false)} title="Close" aria-label="Close"><X size={15} /></button>
            </span>
          </header>
          <div className="adv-fab-body"><TattvaChat seed={null} active={open} compact /></div>
        </section>
      )}
      <button
        type="button"
        className={`adv-fab${dragging ? " dragging" : ""}`}
        style={{ left: pos.x, top: pos.y }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onClick={(e) => e.preventDefault()}
        title="Ask TattvaAI (drag to move)"
        aria-label="Ask TattvaAI. Drag to move."
        aria-expanded={open}
      >
        {open ? <X size={24} /> : <Sparkles size={24} />}
      </button>
    </>
  );
}
