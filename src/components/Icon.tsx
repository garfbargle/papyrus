import type { SVGProps } from "react";

type Name =
  | "all"
  | "archive"
  | "arrowLeft"
  | "chevronDown"
  | "code"
  | "copy"
  | "dots"
  | "file"
  | "folder"
  | "folderPlus"
  | "link"
  | "list"
  | "menu"
  | "more"
  | "paperclip"
  | "pen"
  | "plus"
  | "search"
  | "share"
  | "split"
  | "sun"
  | "trash"
  | "undo"
  | "check";

const paths: Record<Name, string | string[]> = {
  all: "M4 5.5A1.5 1.5 0 0 1 5.5 4h3A1.5 1.5 0 0 1 10 5.5v3A1.5 1.5 0 0 1 8.5 10h-3A1.5 1.5 0 0 1 4 8.5v-3ZM14 5.5A1.5 1.5 0 0 1 15.5 4h3A1.5 1.5 0 0 1 20 5.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 14 8.5v-3ZM4 15.5A1.5 1.5 0 0 1 5.5 14h3a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3ZM14 15.5a1.5 1.5 0 0 1 1.5-1.5h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3a1.5 1.5 0 0 1-1.5-1.5v-3Z",
  archive: "M4 8h16M5 8l1 11h12l1-11M3 5h18v3H3V5Zm7 7h4",
  arrowLeft: "m14 6-6 6 6 6M8 12h12",
  chevronDown: "m7 10 5 5 5-5",
  code: "m8 9-3 3 3 3m8-6 3 3-3 3m-2-8-2 16",
  copy: "M9 8h10v11H9zM5 16H4V5h10v1",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  file: "M7 3h7l4 4v14H7zM14 3v5h5",
  folder: "M3 7.5A1.5 1.5 0 0 1 4.5 6h5L11 8h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-10Z",
  folderPlus: "M3 7.5A1.5 1.5 0 0 1 4.5 6h5L11 8h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-10ZM16 11v5m-2.5-2.5h5",
  link: "M10 13.8a4 4 0 0 0 5.7.1l2.1-2.1a4 4 0 0 0-5.7-5.7l-1.2 1.2M14 10.2a4 4 0 0 0-5.7-.1l-2.1 2.1a4 4 0 0 0 5.7 5.7l1.2-1.2",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  menu: "M4 7h16M4 12h16M4 17h16",
  more: "M12 5v.01M12 12v.01M12 19v.01",
  paperclip: "m9 17 7.5-7.5a3 3 0 1 0-4.2-4.2L5.1 12.5a4.5 4.5 0 1 0 6.4 6.4l7.1-7.1",
  pen: "m14 5 5 5M4 20l4.3-1 10.9-10.9a2.1 2.1 0 0 0-3-3L5.3 16ZM13 6l5 5",
  plus: "M12 5v14M5 12h14",
  search: "m20 20-4.5-4.5m2.5-5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z",
  share: "M15 8l-3-3-3 3M12 5v10m-6 0v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3",
  split: "M5 4h14v16H5zM12 4v16",
  sun: "M12 4v2m0 12v2M6.3 6.3l1.4 1.4m8.6 8.6 1.4 1.4m0-11.4-1.4 1.4m-8.6 8.6-1.4 1.4M4 12h2m12 0h2m-5.8 0a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 0 1 4.4 0Z",
  trash: "M4 7h16m-10 4v5m4-5v5M9 7l1-3h4l1 3m-9 0 1 13h10l1-13",
  undo: "M9 7 4 12l5 5M5 12h9a5 5 0 0 1 5 5",
  check: "m5 12 4 4L19 6",
};

export function Icon({ name, size = 18, ...props }: { name: Name; size?: number } & SVGProps<SVGSVGElement>) {
  const path = paths[name];
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {Array.isArray(path) ? path.map((d) => <path d={d} key={d} />) : <path d={path} />}
    </svg>
  );
}
