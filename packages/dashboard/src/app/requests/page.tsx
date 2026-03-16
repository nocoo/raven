import { redirect } from "next/navigation";

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

/** Redirect /requests to / — the request log is now embedded in the home page. */
export default async function RequestsPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(resolvedParams)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  redirect(query ? `/?${query}` : "/");
}
