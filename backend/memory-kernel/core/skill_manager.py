from __future__ import annotations

from typing import Any, Optional


class SkillManager:
    _project_skills: dict[str, dict[str, list[str]]] = {}

    def set_skill(self, project_id: str, partner_id: str, skill_id: str, enabled: bool) -> None:
        if project_id not in self._project_skills:
            self._project_skills[project_id] = {}
        if partner_id not in self._project_skills[project_id]:
            self._project_skills[project_id][partner_id] = []
        if enabled:
            if skill_id not in self._project_skills[project_id][partner_id]:
                self._project_skills[project_id][partner_id].append(skill_id)
        else:
            if skill_id in self._project_skills[project_id][partner_id]:
                self._project_skills[project_id][partner_id].remove(skill_id)

    def get_skills(self, project_id: str, partner_id: str) -> list[str]:
        return self._project_skills.get(project_id, {}).get(partner_id, [])

    def apply_to_partner(self, project_id: str, partner: Any) -> Any:
        skills = self.get_skills(project_id, getattr(partner, "partner_id", partner.name))
        for skill_id in skills:
            partner.load_skill(skill_id)
        return partner
