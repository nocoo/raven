"use client";

import { ModelPie } from "@/components/models/model-pie";
import { ModelBar } from "@/components/models/model-bar";
import { ModelTable } from "@/components/models/model-table";
import type { ModelStats } from "@/lib/types";

interface ModelsContentProps {
  data: ModelStats[];
}

export function ModelsContent({ data }: ModelsContentProps) {
  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <ModelPie data={data} />
        <ModelBar data={data} />
      </div>
      <ModelTable data={data} />
    </>
  );
}
