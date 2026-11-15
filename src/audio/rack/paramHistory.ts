/**
 * Histórico de alterações de parâmetros — Undo/Redo (v0.2.26).
 *
 * Lógica pura (sem React/DOM), testável: a página alimenta com `record()`
 * a cada mudança e chama `commit()` quando o gesto termina (debounce) —
 * movimentos contínuos de um knob viram UMA operação, não dezenas.
 *
 * Cada entrada guarda `{ key, before, after }` de cada parâmetro alterado
 * (uma macro como PRESSÃO, que mexe em 5 knobs, vira uma única entrada).
 * O histórico é por instrumento (a página mantém um por caminho `.mrq`) e
 * vive só na sessão — nenhum arquivo de áudio é duplicado ou tocado.
 */
import type { LiveParamKey } from './liveControls';

export interface ParamChange {
  key: LiveParamKey;
  before: number;
  after: number;
}

export interface HistoryEntry {
  changes: ParamChange[];
}

export class ParamHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  /** Mudanças do gesto atual (antes do commit): key → { before, after }. */
  private pending = new Map<LiveParamKey, { before: number; after: number }>();

  /**
   * Registra uma mudança. Chamadas repetidas do mesmo parâmetro no mesmo
   * gesto (arraste de knob) atualizam só o `after` — o `before` é o do
   * início do gesto. Retorna quantas mudanças pendentes há.
   */
  record(key: LiveParamKey, before: number, after: number): number {
    const existing = this.pending.get(key);
    if (existing) {
      existing.after = after;
    } else {
      this.pending.set(key, { before, after });
    }
    return this.pending.size;
  }

  /**
   * Confirma o gesto atual como UMA entrada de undo (descarta o que não
   * mudou de verdade). Limpa a pilha de redo (nova edição invalida redo).
   * Retorna `true` se criou uma entrada.
   */
  commit(): boolean {
    const changes: ParamChange[] = [];
    for (const [key, { before, after }] of this.pending) {
      if (before !== after) changes.push({ key, before, after });
    }
    this.pending.clear();
    if (changes.length === 0) return false;
    this.undoStack.push({ changes });
    this.redoStack = [];
    return true;
  }

  /** Desfaz a última entrada (confirma o gesto pendente antes). */
  undo(): HistoryEntry | null {
    this.commit();
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    return entry;
  }

  /** Refaz a última entrada desfeita (confirma o gesto pendente antes). */
  redo(): HistoryEntry | null {
    this.commit();
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    return entry;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0 || this.pending.size > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Quantas entradas aguardam desfazer (inclui o gesto pendente). */
  get undoDepth(): number {
    return this.undoStack.length + (this.pending.size > 0 ? 1 : 0);
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  /** Apaga todo o histórico (ex.: ao restaurar os padrões). */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.pending.clear();
  }
}
