"use client";

import { useState, useEffect } from "react";
import { ModelPie } from "@/components/models/model-pie";
import { ModelBar } from "@/components/models/model-bar";
import { ModelTable } from "@/components/models/model-table";
import type { ModelStats } from "@/lib/types";

interface ModelsContentProps {
  data: ModelStats[];
}

export function ModelsContent({ data }: ModelsContentProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <>
      {mounted ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <ModelPie data={data} />
          <ModelBar data={data} />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="bg-secondary rounded-card p-4 h-[268px]" />
          <div className="bg-secondary rounded-card p-4 h-[268px]" />
        </div>
      )}
      <ModelTable data={data} />
    </>
  );
}
