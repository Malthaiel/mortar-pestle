import registry from './registry.json';
import { bindSkillsBrowserApi } from './api.js';
import SkillsBrowserTab from './SkillsBrowserTab.jsx';

export default {
  register(api) {
    const skillsApi = bindSkillsBrowserApi(api);
    api.slots.registerSettingsTab({
      id: 'skills-browser',
      label: 'Skills Browser',
      render: () => <SkillsBrowserTab registry={registry} skillsApi={skillsApi}/>,
    });
  },
};
