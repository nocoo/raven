import { AlertCircle } from "lucide-react";

interface FetchErrorProps {
  title?: string;
  message: string;
}

export function FetchError({ title = "Connection Error", message }: FetchErrorProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertCircle className="h-6 w-6 text-destructive" strokeWidth={1.5} />
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground mt-1 max-w-md">{message}</p>
      </div>
    </div>
  );
}
