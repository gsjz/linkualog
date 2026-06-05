def _has_text(value) -> bool:
    return bool(str(value or "").strip())


def _is_intentional_blank_example(example: dict) -> bool:
    return bool(
        example.get("intentionalBlank")
        or example.get("intentional_blank")
        or example.get("intentionalblank")
    )


def vocabulary_entry_needs_processing(payload: dict) -> bool:
    """Return True when an entry is missing core learning content."""
    if not isinstance(payload, dict):
        return True

    definitions = payload.get("definitions")
    if not isinstance(definitions, list) or not definitions:
        return True
    has_valid_definition = False
    for definition in definitions:
        if not isinstance(definition, str):
            return True
        if _has_text(definition):
            has_valid_definition = True
        else:
            return True
    if not has_valid_definition:
        return True

    examples = payload.get("examples") if isinstance(payload.get("examples"), list) else []
    for example in examples:
        if not isinstance(example, dict) or _is_intentional_blank_example(example):
            continue
        if _has_text(example.get("text")) and not _has_text(example.get("explanation")):
            return True

    return False
