// Skills data provider. Owns the skill catalog + the per-slug running-job
// map so both the left-sidebar nav (SkillsNav) and the main-content runner
// (SkillsPage) share one source of truth.

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { skillsApi, subscribeSkillsEvent } from './api.js';

const SkillsContext = createContext(null);

export function SkillsProvider({ children }) {
  const [skills, setSkills] = useState({ slash: [], ingest: [], transcripts: [] });
  const [runningJobs, setRunningJobs] = useState({});

  useEffect(() => {
    let cancelled = false;
    skillsApi.getSkills()
      .then(({ categories }) => { if (!cancelled) setSkills(categories); })
      .catch(err => console.warn('getSkills failed:', err));
    skillsApi.listSkillRuns()
      .then(({ runs }) => {
        if (cancelled) return;
        const next = {};
        for (const r of runs) next[r.slug] = r.jobId;
        setRunningJobs(next);
      })
      .catch(err => console.warn('listSkillRuns failed:', err));
    const unsub = subscribeSkillsEvent(() => {
      skillsApi.getSkills().then(({ categories }) => setSkills(categories)).catch(() => {});
    });
    return () => { cancelled = true; unsub(); };
  }, []);

  const value = useMemo(() => ({
    skills,
    runningJobs,
    setRunningJobForSlug: (slug, jobId) => setRunningJobs(prev => ({ ...prev, [slug]: jobId })),
    clearJobForSlug: (slug) => setRunningJobs(prev => {
      if (!(slug in prev)) return prev;
      const next = { ...prev };
      delete next[slug];
      return next;
    }),
  }), [skills, runningJobs]);

  return <SkillsContext.Provider value={value}>{children}</SkillsContext.Provider>;
}

export function useSkillsData() {
  const ctx = useContext(SkillsContext);
  if (!ctx) throw new Error('useSkillsData must be used inside SkillsProvider');
  return ctx;
}

export function findSkillBySlug(skills, slug) {
  if (!slug) return null;
  for (const cat of Object.keys(skills)) {
    const hit = skills[cat].find(s => s.slug === slug);
    if (hit) return { ...hit, category: cat };
  }
  return null;
}
