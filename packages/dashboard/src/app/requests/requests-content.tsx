"use client";

import { Filters } from "@/components/requests/filters";
import { RequestTable } from "@/components/requests/request-table";
import type { RequestRecord } from "@/lib/types";

interface RequestsContentProps {
  data: RequestRecord[];
  hasMore: boolean;
  nextCursor?: string | undefined;
  total?: number | undefined;
}

export function RequestsContent({ data, hasMore, nextCursor, total }: RequestsContentProps) {
  return (
    <>
      <Filters />
      <RequestTable
        data={data}
        hasMore={hasMore}
        nextCursor={nextCursor}
        total={total}
      />
    </>
  );
}
