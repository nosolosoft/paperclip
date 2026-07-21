#!/usr/bin/env bash
set -euo pipefail

readonly API_BASE="http://127.0.0.1:3100/api"
readonly AUTH_FILE="$HOME/.paperclip/auth.json"
readonly COMPANY_ID="22889fc5-fcd0-4953-9c70-0a489d756b85"
readonly COMPANY_NAME="NoSoloSoft"
readonly COMPANY_PREFIX="NSS"
readonly EXPECTED_OPPTESTS_HEAD="8f996c33a61c4b51d474d171d28484d2f0463f24"
readonly OPPTESTS_BACKEND="/home/manu/proyectos/www/opptests/opptests-backend"
readonly WORKTREE_PARENT="$HOME/.paperclip/instances/default/workspaces"
readonly EVIDENCE_DIR=".omo/evidence/recover-opencode-engineer-pilot/T7"
readonly BUNDLE_CONFIG="scripts/agent-pilots/opencode-engineer/bundle/agent-config.json"

mode="${1:---apply}"
if [[ "$mode" != "--apply" && "$mode" != "--simulate-stale-ceo" ]]; then
  printf 'Usage: %s [--apply|--simulate-stale-ceo]\n' "$0" >&2
  exit 64
fi

if [[ ! -d "$EVIDENCE_DIR" || ! -d "$WORKTREE_PARENT" || ! -f "$BUNDLE_CONFIG" ]]; then
  printf 'Required T7 path is unavailable.\n' >&2
  exit 65
fi

tmp_dir="$(mktemp -d)"
created_agent_id=""
pause_confirmed=0
post_attempts=0
token=""

cleanup() {
  local status=$?
  if [[ -n "$created_agent_id" && "$pause_confirmed" -ne 1 && -n "$token" ]]; then
    curl -sS -o /dev/null -w '' -X POST \
      -H "Authorization: Bearer $token" \
      -H 'Content-Type: application/json' \
      "$API_BASE/agents/$created_agent_id/pause" \
      || true
  fi
  for temp_file in "$tmp_dir"/*; do
    [[ -e "$temp_file" ]] && rm -f -- "$temp_file"
  done
  rmdir "$tmp_dir" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT

utc_now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

sha256_json() {
  jq -S -c "$2" "$1" | sha256sum | cut -d ' ' -f 1
}

api_get() {
  local path="$1"
  local output="$2"
  local http_status
  http_status="$(curl -sS -o "$output" -w '%{http_code}' \
    -H "Authorization: Bearer $token" \
    "$API_BASE$path")"
  if [[ "$http_status" != "200" ]]; then
    printf 'GET %s returned HTTP %s.\n' "$path" "$http_status" >&2
    exit 66
  fi
  jq -e . "$output" >/dev/null
}

abort_before_post() {
  local reason="$1"
  local live_ceo_id="${2:-null}"
  local fixture_expected_ceo_id="${3:-null}"
  cat > "$EVIDENCE_DIR/stale-state-abort.txt" <<EOF
status=PASS
scenario=${mode#--}
recorded_at=$(utc_now)
expected_company_id=$COMPANY_ID
expected_company_name=$COMPANY_NAME
expected_prefix=$COMPANY_PREFIX
drift=$reason
live_ceo_id=$live_ceo_id
fixture_expected_ceo_id=$fixture_expected_ceo_id
abort_before_post=true
post_attempts=$post_attempts
secrets_logged=false
EOF
  printf 'Pre-POST authority guard aborted: %s\n' "$reason" >&2
  exit 42
}

if [[ ! -f "$AUTH_FILE" ]]; then
  abort_before_post "board_auth_file_missing"
fi
token="$(jq -er '.credentials["http://127.0.0.1:3100"].token' "$AUTH_FILE")"
if [[ "$token" != pcp_board_* ]]; then
  abort_before_post "board_auth_token_shape_invalid"
fi

api_get "/companies" "$tmp_dir/companies.json"
company_count="$(jq --arg id "$COMPANY_ID" --arg name "$COMPANY_NAME" '[.[] | select(.id == $id and .name == $name)] | length' "$tmp_dir/companies.json")"
if [[ "$company_count" != "1" ]]; then
  abort_before_post "company_id_or_name_drift"
fi

jq --arg id "$COMPANY_ID" '.[] | select(.id == $id)' "$tmp_dir/companies.json" > "$tmp_dir/company.json"
if [[ "$(jq -r '.issuePrefix' "$tmp_dir/company.json")" != "$COMPANY_PREFIX" ]]; then
  abort_before_post "company_prefix_drift"
fi
if [[ "$(jq -r '.requireBoardApprovalForNewAgents' "$tmp_dir/company.json")" != "false" ]]; then
  abort_before_post "require_board_approval_for_new_agents_drift"
fi

api_get "/companies/$COMPANY_ID/agents" "$tmp_dir/agents.json"
api_get "/companies/$COMPANY_ID/issues?limit=100&offset=0&includeRoutineExecutions=true" "$tmp_dir/issues-page-0.json"
issue_page_count="$(jq 'length' "$tmp_dir/issues-page-0.json")"
issue_offset=100
issue_page=1
while [[ "$issue_page_count" -eq 100 ]]; do
  api_get "/companies/$COMPANY_ID/issues?limit=100&offset=$issue_offset&includeRoutineExecutions=true" "$tmp_dir/issues-page-$issue_page.json"
  issue_page_count="$(jq 'length' "$tmp_dir/issues-page-$issue_page.json")"
  issue_offset=$((issue_offset + 100))
  issue_page=$((issue_page + 1))
done
jq -s 'add' "$tmp_dir"/issues-page-*.json > "$tmp_dir/issues.json"

live_ceo_count="$(jq '[.[] | select(.role == "ceo" and .status != "terminated")] | length' "$tmp_dir/agents.json")"
if [[ "$live_ceo_count" != "1" ]]; then
  abort_before_post "ceo_identity_drift"
fi
live_ceo_id="$(jq -r '[.[] | select(.role == "ceo" and .status != "terminated")][0].id' "$tmp_dir/agents.json")"
if [[ -z "$live_ceo_id" || "$live_ceo_id" == "null" ]]; then
  abort_before_post "ceo_identity_missing"
fi
if [[ "$(jq --arg name 'OpenCode Engineer' '[.[] | select(.name == $name and .status != "terminated")] | length' "$tmp_dir/agents.json")" != "0" ]]; then
  abort_before_post "nonterminated_opencode_engineer_name_collision" "$live_ceo_id"
fi

printf '' > "$tmp_dir/agent-supplement.ndjson"
while IFS= read -r agent_id; do
  api_get "/agents/$agent_id/config-revisions" "$tmp_dir/revisions-$agent_id.json"
  api_get "/agents/$agent_id/instructions-bundle" "$tmp_dir/instructions-$agent_id.json"
  latest_config_revision_id="$(jq -r '.[0].id // null' "$tmp_dir/revisions-$agent_id.json")"
  latest_instruction_revision_id="$(jq -r '[.. | objects | (.latestRevisionId?, .revisionId?) | select(type == "string")] | first // null' "$tmp_dir/instructions-$agent_id.json")"
  jq -n \
    --arg id "$agent_id" \
    --arg latest_config_revision_id "$latest_config_revision_id" \
    --arg latest_instruction_revision_id "$latest_instruction_revision_id" \
    --arg config_revisions_sha256 "$(sha256_json "$tmp_dir/revisions-$agent_id.json" '.')" \
    --arg instructions_bundle_sha256 "$(sha256_json "$tmp_dir/instructions-$agent_id.json" '.')" \
    '{
      id: $id,
      latestConfigRevisionId: ($latest_config_revision_id | if . == "null" then null else . end),
      latestInstructionRevisionId: ($latest_instruction_revision_id | if . == "null" then null else . end),
      configRevisionsSha256: $config_revisions_sha256,
      instructionsBundleSha256: $instructions_bundle_sha256
    }' >> "$tmp_dir/agent-supplement.ndjson"
done < <(jq -r '.[].id' "$tmp_dir/agents.json")
jq -s '.' "$tmp_dir/agent-supplement.ndjson" > "$tmp_dir/agent-supplement.json"

write_snapshot() {
  local destination="$1"
  local snapshot_time="$2"
  local agents_file="$3"
  local issues_file="$4"
  local supplement_file="$5"
  jq -S -n \
    --arg company_id "$COMPANY_ID" \
    --arg captured_at "$snapshot_time" \
    --slurpfile agents "$agents_file" \
    --slurpfile issues "$issues_file" \
    --slurpfile supplement "$supplement_file" \
    '
      (reduce $supplement[0][] as $extra ({}; .[$extra.id] = $extra)) as $extras
      | {
          format: "paperclip-agent-state-v1",
          companyId: $company_id,
          capturedAt: $captured_at,
          agents: [
            $agents[0][] as $agent
            | ($extras[$agent.id]) as $extra
            | {
                id: $agent.id,
                name: $agent.name,
                urlKey: $agent.urlKey,
                role: $agent.role,
                title: $agent.title,
                icon: $agent.icon,
                status: $agent.status,
                reportsTo: $agent.reportsTo,
                adapterType: $agent.adapterType,
                defaultEnvironmentId: $agent.defaultEnvironmentId,
                budgetMonthlyCents: $agent.budgetMonthlyCents,
                capabilitiesSha256: ($agent.capabilities | tojson | @base64),
                adapterConfigSha256: ($agent.adapterConfig | tojson | @base64),
                runtimeConfigSha256: ($agent.runtimeConfig | tojson | @base64),
                permissionsSha256: ($agent.permissions | tojson | @base64),
                metadataSha256: ($agent.metadata | tojson | @base64),
                latestConfigRevisionId: $extra.latestConfigRevisionId,
                latestInstructionRevisionId: $extra.latestInstructionRevisionId,
                configRevisionsSha256: $extra.configRevisionsSha256,
                instructionsBundleSha256: $extra.instructionsBundleSha256,
                assignments: [
                  $issues[0][]
                  | select(.assigneeAgentId == $agent.id)
                  | {
                      id,
                      identifier,
                      status,
                      assigneeAgentId,
                      assigneeUserId
                    }
                ] | sort_by(.id)
              }
          ] | sort_by(.id)
        }
    ' > "$destination"
  while IFS= read -r agent_id; do
    local agent_json
    agent_json="$(jq --arg id "$agent_id" '.[] | select(.id == $id)' "$agents_file")"
    jq --arg id "$agent_id" --arg hash "$(printf '%s' "$agent_json" | jq -S -c '.adapterConfig' | sha256sum | cut -d ' ' -f 1)" \
      '(.agents[] | select(.id == $id)).adapterConfigSha256 = $hash' "$destination" > "$tmp_dir/snapshot-next.json"
    mv "$tmp_dir/snapshot-next.json" "$destination"
    jq --arg id "$agent_id" --arg hash "$(printf '%s' "$agent_json" | jq -S -c '.runtimeConfig' | sha256sum | cut -d ' ' -f 1)" \
      '(.agents[] | select(.id == $id)).runtimeConfigSha256 = $hash' "$destination" > "$tmp_dir/snapshot-next.json"
    mv "$tmp_dir/snapshot-next.json" "$destination"
    jq --arg id "$agent_id" --arg hash "$(printf '%s' "$agent_json" | jq -S -c '.permissions' | sha256sum | cut -d ' ' -f 1)" \
      '(.agents[] | select(.id == $id)).permissionsSha256 = $hash' "$destination" > "$tmp_dir/snapshot-next.json"
    mv "$tmp_dir/snapshot-next.json" "$destination"
    jq --arg id "$agent_id" --arg hash "$(printf '%s' "$agent_json" | jq -S -c '.metadata' | sha256sum | cut -d ' ' -f 1)" \
      '(.agents[] | select(.id == $id)).metadataSha256 = $hash' "$destination" > "$tmp_dir/snapshot-next.json"
    mv "$tmp_dir/snapshot-next.json" "$destination"
    jq --arg id "$agent_id" --arg hash "$(printf '%s' "$agent_json" | jq -S -c '.capabilities' | sha256sum | cut -d ' ' -f 1)" \
      '(.agents[] | select(.id == $id)).capabilitiesSha256 = $hash' "$destination" > "$tmp_dir/snapshot-next.json"
    mv "$tmp_dir/snapshot-next.json" "$destination"
  done < <(jq -r '.[].id' "$agents_file")
}

before_time="$(utc_now)"
write_snapshot "$EVIDENCE_DIR/before-snapshot.json" "$before_time" "$tmp_dir/agents.json" "$tmp_dir/issues.json" "$tmp_dir/agent-supplement.json"
jq -S 'del(.capturedAt)' "$EVIDENCE_DIR/before-snapshot.json" > "$EVIDENCE_DIR/before-preexisting.json"

if [[ "$mode" == "--simulate-stale-ceo" ]]; then
  abort_before_post "ceo_id_drift" "$live_ceo_id" "00000000-0000-0000-0000-000000000000"
fi

if [[ ! -d "$OPPTESTS_BACKEND/.git" ]]; then
  abort_before_post "opptests_backend_repository_missing" "$live_ceo_id"
fi
baseline_commit="$(GIT_MASTER=1 git -C "$OPPTESTS_BACKEND" rev-parse HEAD)"
if GIT_MASTER=1 git -C "$OPPTESTS_BACKEND" merge-base --is-ancestor "$EXPECTED_OPPTESTS_HEAD" "$baseline_commit"; then
  baseline_relation="same_or_fast_forward"
else
  baseline_relation="diverged_used_current_head"
fi
baseline_status="$(GIT_MASTER=1 git -C "$OPPTESTS_BACKEND" status --porcelain)"
if [[ -n "$baseline_status" ]]; then
  abort_before_post "opptests_backend_worktree_not_clean" "$live_ceo_id"
fi

worktree_timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
worktree_path="$WORKTREE_PARENT/opencode-engineer-pilot-smoke-$worktree_timestamp"
if [[ -e "$worktree_path" ]]; then
  abort_before_post "smoke_worktree_path_collision" "$live_ceo_id"
fi
GIT_MASTER=1 git -C "$OPPTESTS_BACKEND" worktree add --detach "$worktree_path" "$baseline_commit"
worktree_status="$(GIT_MASTER=1 git -C "$worktree_path" status --porcelain)"
if [[ -n "$worktree_status" ]]; then
  abort_before_post "created_smoke_worktree_not_clean" "$live_ceo_id"
fi

jq --arg reports_to "$live_ceo_id" --arg cwd "$worktree_path" '
  del(._pilotNotes)
  | .reportsTo = $reports_to
  | .adapterConfig.cwd = $cwd
' "$BUNDLE_CONFIG" > "$tmp_dir/create-payload.json"
jq -e --arg reports_to "$live_ceo_id" --arg cwd "$worktree_path" '
  .reportsTo == $reports_to
  and .reportsTo != "00000000-0000-0000-0000-000000000000"
  and .adapterConfig.cwd == $cwd
  and .adapterConfig.cwd != "/home/manu/proyectos/www/opptests-pilot-smoke-placeholder"
  and .runtimeConfig.heartbeat.enabled == false
  and .permissions.canCreateAgents == false
  and .permissions.canCreateSkills == false
' "$tmp_dir/create-payload.json" >/dev/null
new_adapter_config_sha256="$(sha256_json "$tmp_dir/create-payload.json" '.adapterConfig')"

post_attempts=1
create_status="$(curl -sS -o "$tmp_dir/create-response.json" -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' \
  --data-binary "@$tmp_dir/create-payload.json" \
  "$API_BASE/companies/$COMPANY_ID/agents")"
if [[ "$create_status" != "201" ]]; then
  printf 'POST /companies/%s/agents returned HTTP %s.\n' "$COMPANY_ID" "$create_status" >&2
  exit 67
fi
created_agent_id="$(jq -er '.id' "$tmp_dir/create-response.json")"
pause_status="$(curl -sS -o "$tmp_dir/pause-response.json" -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' \
  "$API_BASE/agents/$created_agent_id/pause")"
if [[ "$pause_status" != "200" ]]; then
  printf 'POST /agents/%s/pause returned HTTP %s.\n' "$created_agent_id" "$pause_status" >&2
  exit 68
fi
pause_confirmed=1

api_get "/agents/$created_agent_id" "$tmp_dir/new-agent.json"
api_get "/agents/$created_agent_id/keys" "$tmp_dir/new-agent-keys.json"
api_get "/companies/$COMPANY_ID/heartbeat-runs?agentId=$created_agent_id&limit=1000&summary=true" "$tmp_dir/new-agent-runs.json"
api_get "/companies/$COMPANY_ID/issues?assigneeAgentId=$created_agent_id&limit=100&offset=0&includeRoutineExecutions=true" "$tmp_dir/new-agent-issues.json"
api_get "/companies/$COMPANY_ID/activity?entityType=agent&entityId=$created_agent_id&limit=100" "$tmp_dir/new-agent-activity.json"

if [[ "$(jq -r '.status' "$tmp_dir/new-agent.json")" != "paused" ]]; then
  printf 'Created agent is not paused.\n' >&2
  exit 69
fi
if [[ "$(jq 'length' "$tmp_dir/new-agent-keys.json")" != "0" || "$(jq 'length' "$tmp_dir/new-agent-runs.json")" != "0" || "$(jq 'length' "$tmp_dir/new-agent-issues.json")" != "0" ]]; then
  printf 'Created agent has a key, run, or assignment.\n' >&2
  exit 70
fi
if [[ "$(jq -r '.runtimeConfig.heartbeat.enabled' "$tmp_dir/new-agent.json")" != "false" ]]; then
  printf 'Created agent heartbeat is enabled.\n' >&2
  exit 71
fi

api_get "/companies/$COMPANY_ID/agents" "$tmp_dir/after-agents.json"
api_get "/companies/$COMPANY_ID/issues?limit=100&offset=0&includeRoutineExecutions=true" "$tmp_dir/after-issues-page-0.json"
after_issue_page_count="$(jq 'length' "$tmp_dir/after-issues-page-0.json")"
after_issue_offset=100
after_issue_page=1
while [[ "$after_issue_page_count" -eq 100 ]]; do
  api_get "/companies/$COMPANY_ID/issues?limit=100&offset=$after_issue_offset&includeRoutineExecutions=true" "$tmp_dir/after-issues-page-$after_issue_page.json"
  after_issue_page_count="$(jq 'length' "$tmp_dir/after-issues-page-$after_issue_page.json")"
  after_issue_offset=$((after_issue_offset + 100))
  after_issue_page=$((after_issue_page + 1))
done
jq -s 'add' "$tmp_dir"/after-issues-page-*.json > "$tmp_dir/after-issues.json"

printf '' > "$tmp_dir/after-agent-supplement.ndjson"
while IFS= read -r agent_id; do
  api_get "/agents/$agent_id/config-revisions" "$tmp_dir/after-revisions-$agent_id.json"
  api_get "/agents/$agent_id/instructions-bundle" "$tmp_dir/after-instructions-$agent_id.json"
  latest_config_revision_id="$(jq -r '.[0].id // null' "$tmp_dir/after-revisions-$agent_id.json")"
  latest_instruction_revision_id="$(jq -r '[.. | objects | (.latestRevisionId?, .revisionId?) | select(type == "string")] | first // null' "$tmp_dir/after-instructions-$agent_id.json")"
  jq -n \
    --arg id "$agent_id" \
    --arg latest_config_revision_id "$latest_config_revision_id" \
    --arg latest_instruction_revision_id "$latest_instruction_revision_id" \
    --arg config_revisions_sha256 "$(sha256_json "$tmp_dir/after-revisions-$agent_id.json" '.')" \
    --arg instructions_bundle_sha256 "$(sha256_json "$tmp_dir/after-instructions-$agent_id.json" '.')" \
    '{
      id: $id,
      latestConfigRevisionId: ($latest_config_revision_id | if . == "null" then null else . end),
      latestInstructionRevisionId: ($latest_instruction_revision_id | if . == "null" then null else . end),
      configRevisionsSha256: $config_revisions_sha256,
      instructionsBundleSha256: $instructions_bundle_sha256
    }' >> "$tmp_dir/after-agent-supplement.ndjson"
done < <(jq -r '.[].id' "$tmp_dir/after-agents.json")
jq -s '.' "$tmp_dir/after-agent-supplement.ndjson" > "$tmp_dir/after-agent-supplement.json"

after_time="$(utc_now)"
write_snapshot "$EVIDENCE_DIR/after-snapshot.json" "$after_time" "$tmp_dir/after-agents.json" "$tmp_dir/after-issues.json" "$tmp_dir/after-agent-supplement.json"
jq -S --slurpfile before "$EVIDENCE_DIR/before-preexisting.json" '
  .agents |= map(select(.id as $id | $before[0].agents | any(.id == $id)))
  | del(.capturedAt)
' "$EVIDENCE_DIR/after-snapshot.json" > "$EVIDENCE_DIR/after-preexisting.json"

if ! cmp -s "$EVIDENCE_DIR/before-preexisting.json" "$EVIDENCE_DIR/after-preexisting.json"; then
  printf 'Pre-existing agent state changed.\n' >&2
  exit 72
fi

activity_actions="$(jq -c '[.[] | {action, entityType, entityId}] | sort_by(.action)' "$tmp_dir/new-agent-activity.json")"
if [[ "$(jq --argjson actions "$activity_actions" '[ $actions[] | select(.action == "agent.created" or .action == "agent.paused") ] | length' <<< '{}')" != "2" ]]; then
  printf 'Expected agent creation and pause activity evidence.\n' >&2
  exit 73
fi

jq -S -n \
  --arg recorded_at "$(utc_now)" \
  --arg company_id "$COMPANY_ID" \
  --arg ceo_id "$live_ceo_id" \
  --arg agent_id "$created_agent_id" \
  --arg worktree_path "$worktree_path" \
  --arg baseline_commit "$baseline_commit" \
  --arg baseline_relation "$baseline_relation" \
  --arg baseline_status "$baseline_status" \
  --arg adapter_config_sha256 "$new_adapter_config_sha256" \
  --argjson create_status "$create_status" \
  --argjson pause_status "$pause_status" \
  --argjson activity_actions "$activity_actions" \
  --arg before_hash "$(sha256sum "$EVIDENCE_DIR/before-preexisting.json" | cut -d ' ' -f 1)" \
  --arg after_hash "$(sha256sum "$EVIDENCE_DIR/after-preexisting.json" | cut -d ' ' -f 1)" \
  '{
    status: "PASS",
    task: "T7",
    recordedAt: $recorded_at,
    company: {id: $company_id, name: "NoSoloSoft", issuePrefix: "NSS", requireBoardApprovalForNewAgents: false},
    liveCeoId: $ceo_id,
    creation: {
      responseStatus: $create_status,
      pauseResponseStatus: $pause_status,
      createdAgentId: $agent_id,
      status: "paused",
      heartbeatEnabled: false,
      sanitizedAdapterConfigSha256: $adapter_config_sha256,
      desiredSkillsRequested: true,
      apiKeys: 0,
      heartbeatRuns: 0,
      issueAssignments: 0
    },
    smokeWorktree: {
      path: $worktree_path,
      sourceRepository: "/home/manu/proyectos/www/opptests/opptests-backend",
      baselineCommit: $baseline_commit,
      expectedHeadRelation: $baseline_relation,
      baselineStatusPorcelain: $baseline_status,
      detached: true
    },
    activity: {actions: $activity_actions},
    preExistingDiff: {
      beforeSha256: $before_hash,
      afterSha256: $after_hash,
      byteForByteEqual: true,
      changedAgents: 0,
      changedIssueAssignments: 0
    },
    secretsLogged: false
  }' > "$EVIDENCE_DIR/create-receipt.json"

printf 'T7 created paused agent %s.\n' "$created_agent_id"
