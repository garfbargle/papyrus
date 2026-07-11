export type Category = {
  id: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type Note = {
  id: string;
  title: string;
  body: string;
  categoryId: string | null;
  categoryName?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revisionId: string;
  preview?: string;
};

export type NoteListItem = Omit<Note, "body">;

export type NoteFilter = "all" | "trash" | { categoryId: string };

export type SavePayload = Pick<Note, "id" | "title" | "body" | "categoryId">;
