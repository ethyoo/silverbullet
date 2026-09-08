import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Input,
  Select,
  UrlPrefixInput,
} from "@silverbulletmd/silverbullet/ui";
import { adminApi, getServerInfo, listUsers } from "../api.ts";
import { FolderPicker } from "../FolderPicker.tsx";
import { formatDuration } from "../git_sync_copy.ts";
import {
  type RuntimeAvailability,
  runtimeApiUnavailableReason,
} from "../runtime_availability.ts";
import { FieldErrors, useSlugDefaults } from "../space_fields.tsx";
import type {
  CommitTiming,
  FieldError,
  MemberRole,
  RevisionsMode,
  SpaceAccess,
  SpaceInfo,
  UserInfo,
} from "../types.ts";
import {
  SPACE_SECTIONS,
  settingsPayload,
  type SpaceSection,
} from "../space_settings.ts";

const COMMIT_PRESETS = [
  {
    label: "Responsive — about 30 seconds",
    quietSecs: 30,
    maxIntervalSecs: 300,
  },
  {
    label: "Balanced — about 2 minutes",
    quietSecs: 120,
    maxIntervalSecs: 900,
  },
  {
    label: "Relaxed — about 5 minutes",
    quietSecs: 300,
    maxIntervalSecs: 3600,
  },
];

export function SpaceForm({
  id,
  initial,
  onSaved,
  cancelHref,
  onDeleted,
  onUnauthorized,
  section = "general",
  onDirtyChange,
  connectionDraft = false,
}: {
  id?: string;
  initial?: SpaceInfo;
  onSaved: (id: string, patch?: Partial<SpaceInfo>) => void;
  section?: SpaceSection;
  connectionDraft?: boolean;
  onDirtyChange?: (sections: SpaceSection[]) => void;
  cancelHref: string;
  onDeleted: () => void;
  onUnauthorized: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  // The folder and prefix track a sanitized version of the name until the
  // user edits them by hand. Hostnames never derive from the name, so they
  // get their own plain state below rather than living in this hook.
  const { folder, folderTouched, prefix, onNameChange, setFolder, setPrefix } =
    useSlugDefaults((slug) => `spaces/${slug}`);
  const [bindType, setBindType] = useState<"prefix" | "host">(
    initial?.binding.host ? "host" : "prefix",
  );
  const [hostValue, setHostValue] = useState(initial?.binding.host ?? "");
  const bindValue = bindType === "host" ? hostValue : prefix;

  // Bootstrap from `initial` (edit mode) exactly once. Going through the
  // hook's setters — rather than lazy initial state — also marks folder/prefix
  // as touched, which is what protects an existing space's stored values from
  // being clobbered by a later name edit (mirroring the old `!!initial` seed
  // for `folderTouched`/`bindValueTouched`).
  useEffect(() => {
    if (initial) {
      setFolder(initial.folder);
      if (!initial.binding.host) setPrefix(initial.binding.prefix ?? "");
    }
    // Intentionally run once on mount only.
  }, []);

  const [access, setAccess] = useState<SpaceAccess>(initial?.access ?? "none");
  const [members, setMembers] = useState<Record<string, MemberRole>>(
    Object.fromEntries(
      Object.entries(initial?.members ?? {}).map(([name, m]) => [name, m.role]),
    ),
  );
  const [users, setUsers] = useState<Record<string, UserInfo>>({});
  const [usersError, setUsersError] = useState(false);
  const [readOnly, setReadOnly] = useState(initial?.readOnly ?? false);
  // Off for a new space: shell commands are the most dangerous capability a
  // space can hold, so an admin opts in rather than remembering to opt out.
  // An existing space keeps whatever it was configured with.
  const [shellEnabled, setShellEnabled] = useState(
    initial?.shell.enabled ?? false,
  );
  // Edited as the space-separated string the server's own SB_SHELL_WHITELIST
  // uses, and split back into the config's array on save.
  const [shellWhitelist, setShellWhitelist] = useState(
    (initial?.shell.whitelist ?? []).join(" "),
  );
  // Matches the server's own `runtimeApi` default for a fresh space.
  const [runtimeApi, setRuntimeApi] = useState(initial?.runtimeApi ?? true);
  const [revisions, setRevisions] = useState<RevisionsMode>(
    initial?.revisions ?? "disabled",
  );
  const [revisionsCommit, setRevisionsCommit] = useState<CommitTiming>(
    initial?.revisionsCommit ?? { quietSecs: 30, maxIntervalSecs: 300 },
  );
  const [runtimeAvailability, setRuntimeAvailability] =
    useState<RuntimeAvailability | null>(null);
  const [indexPage, setIndexPage] = useState(initial?.indexPage ?? "index");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "saving">("idle");
  const [hostStatus, setHostStatus] = useState<
    "verified" | "mismatch" | "unreachable" | null
  >(null);

  // Live hostname check: probe the candidate hostname from the browser and
  // compare the answering server's per-boot instance id with our own. Proves
  // DNS + routing + proxy forwarding end to end (from this browser's vantage
  // point). `/.instance` answers on any Host, so this works before the
  // binding exists.
  //
  // Deliberately probed on this page's own scheme and port rather than the
  // https:// shown in the affix: the question is whether the hostname reaches
  // *this* server from here, and an admin on http://localhost:3000 has no TLS
  // to probe. Answering "unreachable" for every local setup would make the
  // check worthless where it is needed most.
  useEffect(() => {
    if (
      bindType !== "host" ||
      !bindValue ||
      bindValue.includes("/") ||
      bindValue.includes(":")
    ) {
      setHostStatus(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const own = await (await fetch("/.instance")).json();
        const port = location.port ? `:${location.port}` : "";
        const probe = await fetch(
          `${location.protocol}//${bindValue}${port}/.instance`,
          { signal: AbortSignal.timeout(4000) },
        );
        const remote = await probe.json();
        setHostStatus(
          remote.instance === own.instance ? "verified" : "mismatch",
        );
      } catch {
        setHostStatus("unreachable");
      }
    }, 400);
    return () => clearTimeout(t);
  }, [bindType, bindValue]);

  // Known users, for the member checklist below.
  const loadUsers = () => {
    setUsersError(false);
    listUsers()
      .then(setUsers)
      .catch((e: any) => {
        if (e.unauthorized) onUnauthorized();
        else setUsersError(true);
      });
  };
  useEffect(loadUsers, []);

  // Whether this server can run the Lua runtime at all — decided at server
  // boot, not per space. A failure here deliberately leaves the checkbox
  // usable: a transient error should not lock an admin out of a setting.
  useEffect(() => {
    getServerInfo()
      .then((info) => setRuntimeAvailability(info.runtimeApi))
      .catch(() => {});
  }, []);
  const runtimeApiUnavailable =
    runtimeApiUnavailableReason(runtimeAvailability);

  const values: Partial<SpaceInfo> = {
    name,
    folder,
    binding: bindType === "host" ? { host: hostValue } : { prefix },
    access,
    members: Object.fromEntries(
      Object.entries(members).map(([username, role]) => [username, { role }]),
    ),
    readOnly,
    shell: {
      enabled: shellEnabled,
      whitelist: shellWhitelist.split(/\s+/).filter(Boolean),
    },
    runtimeApi,
    revisions,
    revisionsCommit,
    indexPage,
  };
  const [savedValues, setSavedValues] = useState<Partial<SpaceInfo>>(() => ({
    ...values,
    folder: initial?.folder ?? folder,
    binding: initial?.binding ?? values.binding,
  }));
  const dirtySections = (Object.keys(SPACE_SECTIONS) as SpaceSection[]).filter(
    (key) =>
      JSON.stringify(settingsPayload(values, key)) !==
      JSON.stringify(settingsPayload(savedValues, key)),
  );
  const dirtyKey = dirtySections.join(",");
  useEffect(() => {
    if (id) onDirtyChange?.(dirtySections);
  }, [id, dirtyKey, onDirtyChange]);
  const [savedSection, setSavedSection] = useState<SpaceSection>();
  const [errorSection, setErrorSection] = useState<SpaceSection>();
  const activeDirty = dirtySections.includes(section);
  const modeBlocked =
    section === "revisions" &&
    connectionDraft &&
    revisions !== initial?.revisions;
  const visible = (value: SpaceSection) =>
    id ? section === value : value === "general";

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (saveState === "saving" || modeBlocked) return;
        setErrorSection(section);
        setSavedSection(undefined);
        if (
          (!id || section === "general") &&
          bindType === "prefix" &&
          !prefix.trim()
        ) {
          setErrors([{ field: "binding", message: "prefix is required" }]);
          return;
        }
        const payload = id ? settingsPayload(values, section) : values;
        setErrors([]);
        setSaveState("saving");
        try {
          if (id) {
            await adminApi(
              "PATCH",
              `spaces/${encodeURIComponent(id)}`,
              payload,
            );
            setSavedValues((previous) => ({ ...previous, ...payload }));
            setSavedSection(section);
            onSaved(id, payload);
          } else {
            const result = await adminApi("POST", "spaces", payload);
            onSaved(result.id);
          }
        } catch (cause) {
          if ((cause as any)?.unauthorized) onUnauthorized();
          else
            setErrors(
              Array.isArray(cause)
                ? cause
                : [{ field: "", message: "Request failed" }],
            );
        } finally {
          setSaveState("idle");
        }
      }}
    >
      {id ? <h2>{SPACE_SECTIONS[section]}</h2> : <h1>Create space</h1>}
      {(!id || errorSection === section) && <FieldErrors errors={errors} />}
      <fieldset class="sb-settings-fields" disabled={saveState === "saving"}>
        <div hidden={!visible("general")}>
          <label for="space-name">Name</label>
          <Input
            id="space-name"
            value={name}
            onInput={(e) => {
              const newName = e.currentTarget.value;
              setName(newName);
              onNameChange(newName);
            }}
          />
          <label for="space-bind-type">Binding</label>
          <Select
            id="space-bind-type"
            value={bindType}
            onChange={(e) =>
              setBindType(e.currentTarget.value as "prefix" | "host")
            }
          >
            <option value="prefix">URL prefix (this host)</option>
            <option value="host">Hostname</option>
          </Select>
          <label for="space-bind-value">
            {bindType === "prefix" ? "Prefix" : "Hostname"}
          </label>
          {bindType === "prefix" ? (
            <UrlPrefixInput
              id="space-bind-value"
              origin={location.origin}
              value={prefix}
              onInput={setPrefix}
            />
          ) : (
            <div class="sb-url-input">
              {/* Only the scheme is fixed, and it is always https://: SilverBullet
              requires TLS, and a host-bound space is reached through whatever
              proxy terminates it — never on this server's own listening port.
              Nothing follows the hostname, so there is no trailing affix; a
              bare "/" only added noise. */}
              <span class="sb-url-affix">https://</span>
              <Input
                id="space-bind-value"
                value={hostValue}
                placeholder="notes.example.com"
                onInput={(e) => setHostValue(e.currentTarget.value)}
              />
            </div>
          )}
          {bindType === "host" && hostStatus && (
            <Fragment>
              {hostStatus === "verified" && (
                <span class="sb-spaces-ok">✓ hostname reaches this server</span>
              )}
              {hostStatus === "mismatch" && (
                <span class="sb-spaces-error">
                  hostname reaches a different server
                </span>
              )}
              {hostStatus === "unreachable" && (
                <span class="sb-spaces-warn">
                  could not verify: hostname does not reach this server from
                  your browser (DNS or proxy not set up yet?)
                </span>
              )}
            </Fragment>
          )}
          {bindType === "prefix" && (
            <p class="sb-help-text">
              For added security, you can bind a space to its own hostname
              (instead of a URL prefix) to better isolate it from your other
              spaces.
            </p>
          )}
          <label for="space-folder">Folder</label>
          <FolderPicker
            id="space-folder"
            value={folder}
            onChange={setFolder}
            apiBase="api/admin"
            browseStart={folderTouched ? undefined : "spaces"}
          />
          <label for="space-index-page">Start page</label>
          <Input
            id="space-index-page"
            value={indexPage}
            onInput={(e) => setIndexPage(e.currentTarget.value)}
          />
        </div>
        <div hidden={!visible("access")}>
          <fieldset class="sb-access-table">
            <legend>Who has access</legend>
            <p class="sb-help-text">
              Note: write members can also author scripts (Space Lua, install
              libraries and plugs) that run for anyone who opens this space.
            </p>
            <div class="sb-access-row sb-access-public">
              <span class="sb-access-who">Public (not signed in)</span>
              <Select
                value={access}
                onChange={(e) =>
                  setAccess(e.currentTarget.value as SpaceAccess)
                }
              >
                <option value="none">No access</option>
                <option value="read">Read</option>
                <option value="write" disabled={readOnly}>
                  Read &amp; write
                </option>
              </Select>
            </div>
            {access === "read" && (
              <Alert variant="info">
                Anyone can read this space without signing in. Page history and
                revisions stay members-only.
              </Alert>
            )}
            {access === "write" && !readOnly && (
              <Alert variant="warning">
                Anyone on the internet can read AND EDIT this space without
                signing in. Only use for auth-proxy or VPN deployments.
              </Alert>
            )}
            {usersError && (
              <Alert variant="error">
                Could not load users:{" "}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    loadUsers();
                  }}
                >
                  retry
                </a>
              </Alert>
            )}
            {!usersError && Object.keys(users).length === 0 && (
              <p>No other users yet — create some in the Users tab.</p>
            )}
            {Object.entries(users)
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([username, u]) => (
                <div class="sb-access-row" key={username}>
                  <span class="sb-access-who">
                    {username}
                    {u.admin && <Badge>admin</Badge>}
                  </span>
                  {u.admin ? (
                    <span class="sb-access-fixed">Full access</span>
                  ) : (
                    <Select
                      value={members[username] ?? "none"}
                      onChange={(e) => {
                        const role = e.currentTarget.value;
                        setMembers((prev) => {
                          const next = { ...prev };
                          if (role === "none") delete next[username];
                          else next[username] = role as MemberRole;
                          return next;
                        });
                      }}
                    >
                      <option value="none">No access</option>
                      <option value="read">Read</option>
                      <option value="write" disabled={readOnly}>
                        Read &amp; write
                      </option>
                    </Select>
                  )}
                </div>
              ))}
            {readOnly && (
              <p class="sb-help-text">
                Write access is disabled while this space is frozen.
              </p>
            )}
          </fieldset>
          <label>
            <Checkbox
              checked={readOnly}
              onChange={(e) => setReadOnly(e.currentTarget.checked)}
            />{" "}
            Freeze this space
            <span class="sb-help-text">
              Nobody can write, including admins.
            </span>
          </label>
        </div>
        <div hidden={!visible("revisions")}>
          <label for="space-revisions">Mode</label>
          <Select
            id="space-revisions"
            disabled={connectionDraft}
            aria-describedby={
              connectionDraft ? "revision-mode-help" : undefined
            }
            value={revisions}
            onChange={(e) =>
              setRevisions(e.currentTarget.value as RevisionsMode)
            }
          >
            <option value="disabled">
              Disabled — revision support switched off entirely
            </option>
            <option value="managed">
              Managed — SilverBullet periodically commits automatically
            </option>
            <option value="unmanaged">
              Unmanaged — show revisions only, no auto commit
            </option>
          </Select>
          {connectionDraft && (
            <p id="revision-mode-help" class="sb-help-text">
              Finish or cancel Git setup below before changing revision mode.
            </p>
          )}
          {revisions === "managed" && (
            <Fragment>
              <label for="space-commit-frequency">Commit frequency</label>
              <Select
                id="space-commit-frequency"
                value={(() => {
                  const i = COMMIT_PRESETS.findIndex(
                    (p) =>
                      p.quietSecs === revisionsCommit.quietSecs &&
                      p.maxIntervalSecs === revisionsCommit.maxIntervalSecs,
                  );
                  return i >= 0 ? String(i) : "custom";
                })()}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  if (v === "custom") return;
                  const preset = COMMIT_PRESETS[Number(v)];
                  setRevisionsCommit({
                    quietSecs: preset.quietSecs,
                    maxIntervalSecs: preset.maxIntervalSecs,
                  });
                }}
              >
                {COMMIT_PRESETS.map((p, i) => (
                  <option value={String(i)} key={p.label}>
                    {p.label}
                  </option>
                ))}
                {!COMMIT_PRESETS.some(
                  (p) =>
                    p.quietSecs === revisionsCommit.quietSecs &&
                    p.maxIntervalSecs === revisionsCommit.maxIntervalSecs,
                ) && (
                  <option value="custom" disabled>
                    {`Custom (${formatDuration(revisionsCommit.quietSecs)} / ${formatDuration(
                      revisionsCommit.maxIntervalSecs,
                    )})`}
                  </option>
                )}
              </Select>
            </Fragment>
          )}
        </div>
        <div hidden={!visible("advanced")}>
          <h3>Shell commands</h3>
          <label>
            <Checkbox
              checked={shellEnabled}
              onChange={(e) => setShellEnabled(e.currentTarget.checked)}
            />{" "}
            Enable shell commands
            <span class="sb-help-text">
              For added security, leave shell off unless this space needs to run
              server commands.
            </span>
          </label>
          {/* Only meaningful while shell commands are on, so it appears with
          them rather than sitting there greyed out. */}
          {shellEnabled && (
            <Fragment>
              <label for="space-shell-whitelist">
                Allowed commands
                <span class="sb-help-text">
                  Space-separated. Leave empty to allow every command.
                </span>
              </label>
              <Input
                id="space-shell-whitelist"
                value={shellWhitelist}
                placeholder="git pandoc"
                onInput={(e) => setShellWhitelist(e.currentTarget.value)}
              />
            </Fragment>
          )}
          {/* The stored flag and its availability stay orthogonal: `runtimeApi`
          means "this space wants the runtime API", availability means "this
          server can currently provide it". Locking the control does not
          rewrite the value, so installing Chrome and restarting lights the
          space up without the admin having to come back here. */}
          <label>
            <Checkbox
              checked={runtimeApi}
              disabled={runtimeApiUnavailable !== null}
              onChange={(e) => setRuntimeApi(e.currentTarget.checked)}
            />{" "}
            Enable runtime API
            {runtimeApiUnavailable && (
              <span class="sb-help-text">{runtimeApiUnavailable}</span>
            )}
          </label>
        </div>
      </fieldset>
      <div class="row">
        <Button
          type="submit"
          variant="primary"
          disabled={
            saveState === "saving" || modeBlocked || (!!id && !activeDirty)
          }
        >
          {saveState === "saving" ? "Saving…" : id ? "Save changes" : "Create"}
        </Button>
        {!id && (
          <a class="sb-button" href={cancelHref}>
            Cancel
          </a>
        )}
        {savedSection === section && !activeDirty && (
          <span role="status">Saved</span>
        )}
      </div>
      {id && section === "general" && (
        <div class="sb-danger-zone">
          <h3>Remove space</h3>
          <p class="sb-help-text">
            Remove this space from the server. Files on disk are kept.
          </p>
          <Button
            type="button"
            variant="danger"
            onClick={async () => {
              if (
                !confirm(
                  `Remove "${initial?.name ?? id}" from the server? Files on disk are kept.`,
                )
              ) {
                return;
              }
              try {
                await adminApi("DELETE", `spaces/${id}`);
                onDeleted();
              } catch (errs) {
                setErrorSection("general");
                if ((errs as any)?.unauthorized) {
                  onUnauthorized();
                  return;
                }
                setErrors(
                  Array.isArray(errs)
                    ? errs
                    : [{ field: "", message: "Request failed" }],
                );
              }
            }}
          >
            Remove space
          </Button>
        </div>
      )}
    </form>
  );
}
