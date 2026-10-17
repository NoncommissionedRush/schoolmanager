"use client";

import { ChevronDown, Download, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { type MouseEvent, useState } from "react";
import { toast } from "sonner";

import { ToneAlert } from "@/components/absences/tone";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type ExportLink = { href: string; label: string };

type Problem = { kind: "tooManyRows"; count: number } | { kind: "error" };

/** The file name from `Content-Disposition`, else the URL's last segment. */
function fileName(response: Response, href: string) {
  const match = /filename="([^"]+)"/.exec(
    response.headers.get("content-disposition") ?? "",
  );
  return match?.[1] ?? href.split("?")[0].split("/").at(-1) ?? "export.csv";
}

/**
 * _Export CSV_ (reports.md §4.3): plain links to the CSV route, so they work
 * without JavaScript. With it, the file is fetched first: a refusal
 * (`TOO_MANY_ROWS`, 422) shows an alert instead of downloading an error.
 * Several links (teacher hours) open a menu.
 */
export function ExportButton({
  links,
  max,
}: {
  links: ExportLink[];
  /** `REPORT_MAX_ROWS`, for the too-many-rows alert. */
  max: number;
}) {
  const t = useTranslations("reports.export");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function download(href: string) {
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch(href, { credentials: "same-origin" });
      if (response.status === 422) {
        const body = (await response.json()) as {
          code: string;
          count?: number;
        };
        setProblem(
          body.code === "TOO_MANY_ROWS" && body.count !== undefined
            ? { kind: "tooManyRows", count: body.count }
            : { kind: "error" },
        );
        return;
      }
      if (!response.ok) {
        setProblem({ kind: "error" });
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName(response, href);
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t("done"));
    } catch {
      setProblem({ kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  const onClick = (href: string) => (event: MouseEvent) => {
    event.preventDefault();
    if (!busy) void download(href);
  };
  const label = busy ? t("preparing") : t("label");
  const icon = <Download aria-hidden="true" />;

  return (
    <div className="flex flex-col items-end gap-2">
      {links.length === 1 ? (
        <a
          href={links[0].href}
          download
          onClick={onClick(links[0].href)}
          aria-disabled={busy || undefined}
          className={buttonVariants({ variant: "outline" })}
        >
          {icon}
          {label}
        </a>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            className={buttonVariants({ variant: "outline" })}
            disabled={busy}
          >
            {icon}
            {label}
            <ChevronDown aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {links.map((link) => (
              <DropdownMenuItem
                key={link.href}
                render={<a href={link.href} download />}
                onClick={onClick(link.href)}
              >
                {link.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <div role="status" className="max-w-md">
        {problem && (
          <ToneAlert tone="warning" icon={TriangleAlert}>
            {problem.kind === "tooManyRows"
              ? t("tooManyRows", { count: problem.count, max })
              : t("error")}
          </ToneAlert>
        )}
      </div>
    </div>
  );
}
