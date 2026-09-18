import { supabase } from "./supabase";

// Private bucket for task voice notes and images. Object path convention
// is {org_id}/{task_id}/{filename} — RLS policies on storage.objects check
// org membership directly from the first path segment (see supabase/schema.sql).
export const TASK_MEDIA_BUCKET = "task-media";

// Uploads a task attachment and returns the stored object PATH — never a
// signed URL. Throws on failure so callers can show an explicit error
// instead of silently treating the attachment as saved.
export async function uploadTaskMedia(orgId: string, taskId: string, file: Blob, extension: string): Promise<string> {
  const path = `${orgId}/${taskId}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from(TASK_MEDIA_BUCKET).upload(path, file);
  if (error) throw error;
  return path;
}

// Signed URLs must be generated fresh at render time, never stored — one
// saved to the database would silently expire and break playback later.
// Returns null (rather than throwing) so display components can render an
// explicit error state instead of crashing.
export async function resolveSignedUrl(path: string | null | undefined, expiresIn = 3600): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(TASK_MEDIA_BUCKET).createSignedUrl(path, expiresIn);
  if (error || !data) return null;
  return data.signedUrl;
}
