"use client";

import { useState, useTransition } from "react";
import { Trash2, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { deleteOrganisation } from "@/app/actions/org";

/**
 * Delete-org button + confirmation modal.
 *
 * Two-step destructive flow: button opens modal → admin must type the
 * exact org slug to confirm → server action runs wipeOrg() in a single
 * transaction. The action itself authorises (superadmin OR OWNER).
 *
 * Only rendered for users who can perform the action — the parent page
 * decides visibility, this component just handles UX.
 */
export function DeleteOrgButton({
  orgId,
  orgName,
  orgSlug,
}: {
  orgId: string;
  orgName: string;
  orgSlug: string;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, start] = useTransition();

  function close() {
    if (pending) return;
    setOpen(false);
    setTyped("");
  }

  function onConfirm() {
    if (typed.trim() !== orgSlug) return;
    start(async () => {
      try {
        await deleteOrganisation(orgId, orgSlug);
        toast.success(`Deleted "${orgName}"`);
        setOpen(false);
        setTyped("");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Delete failed");
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Delete organisation"
        className="px-3 py-2 rounded-lg border border-red-200 bg-white hover:bg-red-50 text-red-600 text-sm font-medium inline-flex items-center gap-1.5"
      >
        <Trash2 className="w-4 h-4" />
        Delete
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4"
          onClick={close}
        >
          <div
            className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">
                  Delete &quot;{orgName}&quot;?
                </h3>
                <p className="text-sm text-slate-600 mt-1">
                  Permanently removes the organisation, all matches, attendances,
                  ratings, MoM votes, sport settings, and bot history. This
                  cannot be undone.
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                className="p-1 rounded-md text-slate-400 hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-900 mb-4">
              <p className="font-medium mb-1">This is destructive.</p>
              <p>
                Type the org slug{" "}
                <span className="font-mono font-semibold">{orgSlug}</span>{" "}
                below to confirm.
              </p>
            </div>

            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={orgSlug}
              autoFocus
              className="w-full h-11 px-3 rounded-lg border border-slate-300 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
            />

            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={close}
                disabled={pending}
                className="px-4 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={pending || typed.trim() !== orgSlug}
                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center gap-2"
              >
                {pending && <Loader2 className="w-4 h-4 animate-spin" />}
                Delete forever
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
