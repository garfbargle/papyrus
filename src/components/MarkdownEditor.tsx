import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { insertNewlineContinueMarkup, markdown } from "@codemirror/lang-markdown";
import { searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers, placeholder } from "@codemirror/view";

type Props = { value: string; onChange: (value: string) => void; onReady?: (view: EditorView) => void };

export default function MarkdownEditor({ value, onChange, onReady }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const changedByUser = useRef(false);

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(), history(), drawSelection(), highlightActiveLine(), markdown(),
        placeholder("Start writing…"),
        keymap.of([{ key: "Enter", run: insertNewlineContinueMarkup }, indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) { changedByUser.current = true; onChange(update.state.doc.toString()); }
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view; onReady?.(view);
    return () => view.destroy();
  // The editor owns its document after initialization; external updates are handled below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === view.state.doc.toString()) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    changedByUser.current = false;
  }, [value]);

  return <div className="markdown-editor" ref={host} />;
}
