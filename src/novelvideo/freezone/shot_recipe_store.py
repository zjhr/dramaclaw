"""Shot recipe (镜头配方) persistence — Phase 1 backend slice.

One append-only JSONL per recipe under
``<state_dir>/freezone/_shot_recipes/<recipe_id>.jsonl``, resolved through
:func:`novelvideo.freezone.paths.freezone_root` like every other freezone
artifact (no second root).

Storage discipline is copied from :mod:`novelvideo.freezone.history`: one module
owns the record schema (the ``build_*`` constructors below are the single owner),
files are append-only, and deletion is an appended tombstone rather than a
rewrite.  Rewriting a JSONL file while another request appends to it can lose the
concurrent line — and for versions it would also let a *failed* attempt overwrite
the parent version it branched from.

Line kinds (``record_type``): ``recipe`` (header, first line), ``look_decision``
(shot-level CharacterIdentity overrides), ``version`` (one attempt with its
lineage/cost/model snapshot), ``tombstone``.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from novelvideo.freezone.paths import freezone_root

SCHEMA_VERSION = 1

# Recipe ids become a file name — same whitelist as canvas ids.
RECIPE_ID_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,64}$")

VERSION_STATUSES = frozenset(
    {"draft", "ready", "rendering", "completed", "failed", "cancelled"}
)

# Capability keys frozen into a version's model snapshot.
_MODEL_SNAPSHOT_INT_KEYS = (
    "minDuration",
    "maxDuration",
    "referenceImageMax",
    "referenceVideoMax",
    "referenceAudioMax",
    "referenceFileMax",
    "referenceLinkMax",
)
_MODEL_SNAPSHOT_LIST_KEYS = ("supportedModes", "resolutionOptions")

# 身份锁定字段：面部与参考图锚点，镜头级覆盖会与身份基线形成显式 diff。
IDENTITY_LOCKED_KEYS = (
    "face_prompt",
    "reference_images",
)
# 允许镜头内变化的字段：服装与声线按镜头调整是常态。
SHOT_VARIABLE_KEYS = (
    "appearance_details",
    "costume_image",
    "voice",
)
# The only CharacterIdentity fields a look decision may override per shot.
LOOK_DECISION_OVERRIDE_KEYS = IDENTITY_LOCKED_KEYS + SHOT_VARIABLE_KEYS

# 快照字段 → CharacterIdentity 属性。``voice`` 取身份级 IndexTTS2 参考音频路径。
IDENTITY_SNAPSHOT_FIELD_ATTRS = {
    "face_prompt": "face_prompt",
    "appearance_details": "appearance_details",
    "costume_image": "costume_image",
    "reference_images": "reference_images",
    "voice": "reference_audio_path",
}

_RECORD_ID_KEYS = {
    "recipe": "recipe_id",
    "version": "version_id",
    "look_decision": "decision_id",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def new_recipe_id() -> str:
    return f"recipe_{uuid.uuid4().hex[:12]}"


def new_look_decision_id() -> str:
    return f"look_{uuid.uuid4().hex[:12]}"


def shot_recipes_dir(project_dir: Path) -> Path:
    return freezone_root(project_dir) / "_shot_recipes"


def shot_recipe_path(project_dir: Path, recipe_id: str) -> Path:
    clean = str(recipe_id or "").strip()
    if not RECIPE_ID_RE.match(clean):
        raise ValueError(f"invalid recipe_id: {recipe_id!r}")
    return shot_recipes_dir(project_dir) / f"{clean}.jsonl"


# --------------------------------------------------------------------------
# Schema owners
# --------------------------------------------------------------------------


def build_recipe_record(
    *,
    recipe_id: str,
    title: str = "",
    canvas_id: str | None = None,
    node_id: str | None = None,
) -> dict[str, Any]:
    """Canonical recipe header — the first line of every recipe file."""
    return {
        "schema_version": SCHEMA_VERSION,
        "record_type": "recipe",
        "recipe_id": str(recipe_id),
        "title": str(title or ""),
        "canvas_id": canvas_id or None,
        "node_id": node_id or None,
        "recorded_at": _now(),
    }


def _snapshot_value(identity: Any, key: str) -> Any:
    value = getattr(identity, IDENTITY_SNAPSHOT_FIELD_ATTRS[key], None)
    if key == "reference_images":
        return [str(item) for item in value] if isinstance(value, list) else []
    return str(value or "")


def build_identity_snapshot(
    *,
    identity: Any = None,
    identity_id: str,
    reason: str = "",
) -> dict[str, Any]:
    """冻结 CharacterIdentity 基线字段，作为 overrides 的对比基准。

    这只是**溯源快照**：镜头决策依旧只引用 ``identity_id``，角色库才是数据源。
    ``identity`` 为 None 表示角色库读取不可用（或身份不存在），此时
    ``identity_known=false`` 且基线全空——绝不伪装成已解析。
    """
    known = identity is not None
    snapshot: dict[str, Any] = {
        "identity_id": str(identity_id or ""),
        "identity_known": known,
        "known_at": _now(),
    }
    for key in LOOK_DECISION_OVERRIDE_KEYS:
        snapshot[key] = _snapshot_value(identity, key) if known else None
    if not known:
        snapshot["reason"] = reason or "identity library unavailable"
    return snapshot


def build_look_decision_record(
    *,
    decision_id: str,
    identity_id: str,
    character_name: str = "",
    overrides: dict[str, Any] | None = None,
    identity_snapshot: dict[str, Any] | None = None,
    version_id: str | None = None,
    source_refs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One shot-level look decision.

    The decision only *references* an existing CharacterIdentity by
    ``identity_id`` and carries per-shot overrides for a fixed set of fields —
    the character library itself is never copied in here.  ``identity_snapshot``
    is the frozen baseline the overrides are diffed against, and
    ``look_diff`` is that diff: identity-locked fields (face/refs) are kept
    apart from fields a shot may vary (costume/voice).
    """
    clean_identity = str(identity_id or "").strip()
    if not clean_identity:
        raise ValueError("identity_id is required")
    given = dict(overrides or {})
    unknown = sorted(set(given) - set(LOOK_DECISION_OVERRIDE_KEYS))
    if unknown:
        raise ValueError("unknown look decision overrides: " + ", ".join(unknown))
    applied = {
        key: given[key]
        for key in LOOK_DECISION_OVERRIDE_KEYS
        if given.get(key) is not None
    }
    snapshot = dict(identity_snapshot or build_identity_snapshot(identity_id=clean_identity))
    return {
        "schema_version": SCHEMA_VERSION,
        "record_type": "look_decision",
        "decision_id": str(decision_id),
        "identity_id": clean_identity,
        "character_name": str(character_name or ""),
        "version_id": version_id or None,
        "identity_known": bool(snapshot.get("identity_known")),
        "identity_snapshot": snapshot,
        "overrides": applied,
        "look_diff": build_look_diff(snapshot=snapshot, overrides=applied),
        "source_refs": dict(source_refs or {}),
        "recorded_at": _now(),
    }


def build_look_diff(
    *, snapshot: dict[str, Any], overrides: dict[str, Any]
) -> dict[str, Any]:
    """显式 base vs override diff，锁定字段与镜头内可变字段分开表达。

    ``changed`` 只在**该镜头确实覆盖了**该字段且覆盖值不同于基线时为真：没有覆盖
    意味着沿用基线，不算变化。
    """
    diff = {
        key: {
            "base": snapshot.get(key),
            "override": overrides.get(key),
            "changed": key in overrides and overrides.get(key) != snapshot.get(key),
        }
        for key in LOOK_DECISION_OVERRIDE_KEYS
    }
    return {
        "identity_locked": {key: diff[key] for key in IDENTITY_LOCKED_KEYS},
        "shot_variable": {key: diff[key] for key in SHOT_VARIABLE_KEYS},
    }


def build_prompt_delta(
    *,
    prompt: str,
    changes: dict[str, Any] | None = None,
    has_parent: bool,
) -> dict[str, Any]:
    """Prompt delta relative to the parent version.

    The first version has no parent, so it stores the full prompt
    (``mode="full"``); every later version stores the changed prompt text plus
    the changed fields (``mode="delta"``).
    """
    return {
        "mode": "delta" if has_parent else "full",
        "prompt": str(prompt or ""),
        "changes": dict(changes or {}),
    }


def build_model_snapshot(
    *,
    model_id: str = "",
    catalog_id: str | None = None,
    capabilities: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Freeze the capability subset a version was created against.

    ``capabilities`` is the catalog entry for the model, or ``None`` when the
    catalog could not be read.  A missing catalog is recorded as
    ``capabilities_known=False`` with empty values — never as "supported".
    """
    known = isinstance(capabilities, dict)
    snapshot: dict[str, Any] = {
        "model_id": str(model_id or "").strip(),
        "catalog_id": catalog_id or None,
        "capabilities_known": known,
        "frozen_at": _now(),
    }
    for key in _MODEL_SNAPSHOT_INT_KEYS:
        value = capabilities.get(key) if known else None
        snapshot[key] = value if type(value) is int else None
    for key in _MODEL_SNAPSHOT_LIST_KEYS:
        value = capabilities.get(key) if known else None
        snapshot[key] = (
            [str(item) for item in value if str(item).strip()]
            if isinstance(value, list)
            else []
        )
    return snapshot


def build_cost_ledger(
    *,
    quote: Any = None,
    pricing_kind: str = "",
    pricing_model: str = "",
    pricing_params: dict[str, Any] | None = None,
    quantity: int = 1,
    reason: str = "",
) -> dict[str, Any]:
    """Record the credit quote for one version.

    This is a *record* of the existing billing path (``get_credit_quote()`` +
    the model_credits pricing params) — no credit, charge, balance or ledger
    mechanism of its own.  When the quote is unavailable the ledger says so
    explicitly instead of inventing a cost.
    """
    if quote is None:
        return {
            "source": "generation_credit_quote",
            "quoted": False,
            "reason": reason or "credit quote unavailable",
            "pricing_kind": str(pricing_kind or ""),
            "pricing_model": str(pricing_model or ""),
            "pricing_params": dict(pricing_params or {}),
            "quantity": int(quantity or 0),
            "recorded_at": _now(),
        }
    return {
        "source": "generation_credit_quote",
        "quoted": True,
        "pricing_kind": str(pricing_kind or ""),
        "pricing_model": str(pricing_model or ""),
        "pricing_params": dict(pricing_params or {}),
        "quantity": int(getattr(quote, "quantity", quantity) or quantity or 0),
        "total_cost": int(getattr(quote, "total_cost", 0) or 0),
        "display": str(getattr(quote, "display", "") or ""),
        "unit": str(getattr(quote, "unit", "call") or "call"),
        "unit_cost": int(getattr(quote, "unit_cost", 0) or 0),
        "recorded_at": _now(),
    }


def new_shot_job_id() -> str:
    """One render job — same freezone-shaped id as every other video job."""
    return f"job_{uuid.uuid4().hex[:12]}"


def build_version_record(
    *,
    version_id: str,
    parent_version_id: str | None,
    prompt_delta: dict[str, Any],
    model_snapshot: dict[str, Any],
    cost_ledger: dict[str, Any],
    status: str,
    source_refs: dict[str, Any] | None = None,
    look_decision_ids: list[str] | None = None,
    duration_seconds: float | None = None,
    resolution: str | None = None,
    model_id: str | None = None,
) -> dict[str, Any]:
    """Canonical version record — single owner of the version schema."""
    clean_status = str(status or "").strip()
    if clean_status not in VERSION_STATUSES:
        raise ValueError(f"invalid version status: {status!r}")
    return {
        "schema_version": SCHEMA_VERSION,
        "record_type": "version",
        "version_id": str(version_id),
        "parent_version_id": parent_version_id or None,
        "prompt_delta": dict(prompt_delta),
        "model_snapshot": dict(model_snapshot),
        "cost_ledger": dict(cost_ledger),
        "status": clean_status,
        "source_refs": dict(source_refs or {}),
        "look_decision_ids": [str(item) for item in (look_decision_ids or [])],
        "duration_seconds": duration_seconds,
        "resolution": resolution or None,
        "model_id": model_id or None,
        "recorded_at": _now(),
    }


# --------------------------------------------------------------------------
# Append / read
# --------------------------------------------------------------------------


def _append_line(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")


def append_recipe_record(*, project_dir: Path, record: dict[str, Any]) -> dict[str, Any]:
    _append_line(shot_recipe_path(project_dir, record["recipe_id"]), record)
    return record


def append_look_decision_record(
    *, project_dir: Path, recipe_id: str, record: dict[str, Any]
) -> dict[str, Any]:
    _append_line(shot_recipe_path(project_dir, recipe_id), record)
    return record


def append_version_record(
    *, project_dir: Path, recipe_id: str, record: dict[str, Any]
) -> dict[str, Any]:
    """Append one version.  Nothing already on disk is ever rewritten."""
    _append_line(shot_recipe_path(project_dir, recipe_id), record)
    return record


def next_version_id(*, project_dir: Path, recipe_id: str) -> str:
    """Sequential per-recipe version id (v1, v2, ...).

    Counts *distinct* version ids, not raw lines: one version can legitimately be
    appended more than once (``ready`` → ``rendering``), and a state change must
    not burn a version number.

    ponytail: derived from the file length, so two concurrent appends to the
    same recipe can collide.  Single-writer per recipe is the current ceiling;
    switch to uuid ids if concurrent writers ever appear.
    """
    versions = _current_versions(_read_lines(shot_recipe_path(project_dir, recipe_id)))
    return f"v{len(versions) + 1}"


def delete_version(*, project_dir: Path, recipe_id: str, version_id: str) -> bool:
    """Hide one version behind an append-only tombstone.

    The version line stays on disk: lineage must remain auditable, and rewriting
    the file could drop a concurrent append.
    """
    clean = str(version_id or "").strip()
    if not clean:
        raise ValueError("version_id is required")
    path = shot_recipe_path(project_dir, recipe_id)
    if not any(
        record.get("record_type") == "version" and record.get("version_id") == clean
        for record in _read_lines(path)
    ):
        return False
    _append_line(
        path,
        {
            "schema_version": SCHEMA_VERSION,
            "record_type": "tombstone",
            "deleted_record_type": "version",
            "deleted_record_id": clean,
            "recorded_at": _now(),
        },
    )
    return True


def _read_lines(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    deleted: set[tuple[str, str]] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(value, dict):
            continue
        if value.get("record_type") == "tombstone":
            deleted.add(
                (
                    str(value.get("deleted_record_type") or ""),
                    str(value.get("deleted_record_id") or ""),
                )
            )
            continue
        records.append(value)
    if not deleted:
        return records
    kept: list[dict[str, Any]] = []
    for record in records:
        record_type = str(record.get("record_type") or "")
        id_key = _RECORD_ID_KEYS.get(record_type)
        record_id = str(record.get(id_key) or "") if id_key else ""
        if (record_type, record_id) in deleted:
            continue
        kept.append(record)
    return kept


def _current_versions(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Latest line per version_id, in first-seen order.

    A version id can appear on more than one line (``ready`` → ``rendering``),
    and the file is append-only, so the last line wins.
    """
    latest: dict[str, dict[str, Any]] = {}
    for record in records:
        if record.get("record_type") != "version":
            continue
        latest[str(record.get("version_id") or "")] = record
    return list(latest.values())


def read_recipe(project_dir: Path, recipe_id: str) -> dict[str, Any] | None:
    """Read a recipe with its look decisions and versions, or None if absent."""
    records = _read_lines(shot_recipe_path(project_dir, recipe_id))
    header = next(
        (record for record in records if record.get("record_type") == "recipe"), None
    )
    if header is None:
        return None
    return {
        "recipe": header,
        "look_decisions": [
            record for record in records if record.get("record_type") == "look_decision"
        ],
        "versions": _current_versions(records),
    }


def list_shot_recipes(project_dir: Path) -> list[dict[str, Any]]:
    """Recipe headers for a project, newest first.  Malformed files are skipped."""
    directory = shot_recipes_dir(project_dir)
    if not directory.is_dir():
        return []
    headers: list[dict[str, Any]] = []
    for path in sorted(directory.glob("*.jsonl")):
        recipe = read_recipe(project_dir, path.stem)
        if recipe is not None:
            headers.append(recipe["recipe"])
    headers.sort(key=lambda record: str(record.get("recorded_at") or ""), reverse=True)
    return headers


def version_lineage(versions: list[dict[str, Any]], version_id: str) -> list[str]:
    """Root → … → version id chain; stops on a cycle or a missing parent."""
    by_id = {str(record.get("version_id") or ""): record for record in versions}
    chain: list[str] = []
    current = str(version_id or "")
    while current and current in by_id and current not in chain:
        chain.append(current)
        current = str(by_id[current].get("parent_version_id") or "")
    return list(reversed(chain))
