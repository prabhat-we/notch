/* ─── Database types ──────────────────────────────────────────
 * Hand-written to match supabase/schema.sql.
 * ──────────────────────────────────────────────────────────── */

export type MembershipRole = "owner" | "employee";
export type TaskStatus = "todo" | "in-progress" | "done";
export type TaskPriority = "low" | "medium" | "high";

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string;
          name: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      memberships: {
        Row: {
          id: string;
          org_id: string;
          user_id: string | null;
          email: string;
          role: MembershipRole;
          full_name: string | null;
          title: string;
          color: string;
          manager_id: string | null;
          invited_at: string;
          joined_at: string | null;
        };
        Insert: {
          id?: string;
          org_id: string;
          user_id?: string | null;
          email: string;
          role: MembershipRole;
          full_name?: string | null;
          title?: string;
          color?: string;
          manager_id?: string | null;
          invited_at?: string;
          joined_at?: string | null;
        };
        Update: {
          id?: string;
          org_id?: string;
          user_id?: string | null;
          email?: string;
          role?: MembershipRole;
          full_name?: string | null;
          title?: string;
          color?: string;
          manager_id?: string | null;
          invited_at?: string;
          joined_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "memberships_org_id_fkey";
            columns: ["org_id"];
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "memberships_manager_id_fkey";
            columns: ["manager_id"];
            referencedRelation: "memberships";
            referencedColumns: ["id"];
          },
        ];
      };
      tasks: {
        Row: {
          id: string;
          org_id: string;
          title: string;
          description: string;
          assignee_id: string | null;
          created_by: string | null;
          status: TaskStatus;
          priority: TaskPriority;
          due_date: string | null;
          voice_note_url: string | null;
          image_urls: string[];
          sort_order: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          title: string;
          description?: string;
          assignee_id?: string | null;
          created_by?: string | null;
          status?: TaskStatus;
          priority?: TaskPriority;
          due_date?: string | null;
          voice_note_url?: string | null;
          image_urls?: string[];
          sort_order?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          org_id?: string;
          title?: string;
          description?: string;
          assignee_id?: string | null;
          created_by?: string | null;
          status?: TaskStatus;
          priority?: TaskPriority;
          due_date?: string | null;
          voice_note_url?: string | null;
          image_urls?: string[];
          sort_order?: number;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tasks_org_id_fkey";
            columns: ["org_id"];
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_assignee_id_fkey";
            columns: ["assignee_id"];
            referencedRelation: "memberships";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_created_by_fkey";
            columns: ["created_by"];
            referencedRelation: "memberships";
            referencedColumns: ["id"];
          },
        ];
      };
      comments: {
        Row: {
          id: string;
          task_id: string;
          author_id: string | null;
          text: string;
          image_urls: string[];
          created_at: string;
        };
        Insert: {
          id?: string;
          task_id: string;
          author_id?: string | null;
          text: string;
          image_urls?: string[];
          created_at?: string;
        };
        Update: {
          id?: string;
          task_id?: string;
          author_id?: string | null;
          text?: string;
          image_urls?: string[];
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "comments_task_id_fkey";
            columns: ["task_id"];
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "comments_author_id_fkey";
            columns: ["author_id"];
            referencedRelation: "memberships";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}
