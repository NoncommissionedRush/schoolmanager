"use client";

import { ChevronDown, LogOut } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Role } from "@/generated/prisma/enums";

import { signOutAction } from "./actions";

export function UserMenu({
  name,
  firstName,
  initials,
  email,
  role,
}: {
  name: string;
  firstName: string;
  initials: string;
  email: string;
  role: Role;
}) {
  const t = useTranslations("layout");
  const [signingOut, startSignOut] = useTransition();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="h-9 gap-2 px-1.5 md:px-2"
            aria-label={t("userMenu.label", { name })}
          />
        }
      >
        <Avatar size="sm" className="size-7">
          <AvatarFallback className="bg-accent text-xs font-medium text-accent-foreground">
            {initials}
          </AvatarFallback>
        </Avatar>
        <span className="hidden max-w-32 truncate md:inline">{firstName}</span>
        <ChevronDown aria-hidden="true" className="hidden md:inline" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <div className="flex flex-col gap-1 px-2 py-1.5">
          <span className="truncate font-medium">{name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {email}
          </span>
          <Badge variant="secondary" className="mt-1">
            {t(`role.${role}`)}
          </Badge>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onClick={() => startSignOut(() => signOutAction())}
        >
          <LogOut aria-hidden="true" />
          {t("userMenu.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
