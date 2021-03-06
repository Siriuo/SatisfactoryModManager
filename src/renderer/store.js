/* eslint-disable no-param-reassign */
import Vue from 'vue';
import Vuex from 'vuex';
import {} from './utils';
import {
  addDownloadProgressCallback, getProfiles, loadCache, getInstalls, SatisfactoryInstall, getAvailableSMLVersions, MODS_PER_PAGE, getModsCount,
  getAvailableMods,
  createProfile,
  deleteProfile,
} from 'satisfactory-mod-manager-api';
import { satisfies, coerce, valid } from 'semver';
import { ipcRenderer } from 'electron';
import { saveSetting, getSetting } from './settings';

Vue.use(Vuex);

const MAX_DOWNLOAD_NAME_LENGTH = 25;

function limitDownloadNameLength(name) {
  if (name.length > MAX_DOWNLOAD_NAME_LENGTH) {
    return `${name.substr(0, MAX_DOWNLOAD_NAME_LENGTH - 3)}...`;
  }
  return name;
}

export default new Vuex.Store({
  state: {
    filters: {
      modFilters: {},
      sortBy: '',
      search: '',
    },
    profiles: [],
    selectedProfile: {},
    modFilters: [{ name: 'All mods', mods: 0 }, { name: 'Compatible', mods: 0 }, { name: 'Favourite', mods: 0 }, { name: 'Installed', mods: 0 }, { name: 'Not installed', mods: 0 }],
    sortBy: ['Last updated', 'Name', 'Popularity', 'Hotness', 'Views', 'Downloads'],
    satisfactoryInstalls: [],
    selectedInstall: {},
    smlVersions: [],
    mods: [],
    expandedModId: '',
    favoriteModIds: [],
    inProgress: [], // { id: string, progresses: { id: string, progress: number, message: string, fast: boolean }[] }
    currentDownloadProgress: {},
    error: '',
    isGameRunning: false,
    isLaunchingGame: false,
    expandModInfoOnStart: false,
  },
  mutations: {
    setFilters(state, { newFilters }) {
      state.filters = newFilters;
    },
    setInstall(state, { newInstall }) {
      state.selectedInstall = newInstall;
    },
    setProfile(state, { newProfile }) {
      state.selectedProfile = newProfile;
    },
    setInstalls(state, { installs }) {
      state.satisfactoryInstalls = installs;
    },
    setProfiles(state, { profiles }) {
      state.profiles = profiles;
    },
    setFavoriteModIds(state, { favoriteModIds }) {
      state.favoriteModIds = favoriteModIds;
    },
    setSMLVersions(state, { smlVersions }) {
      state.smlVersions = smlVersions;
    },
    refreshModsInstalledCompatible(state) {
      const installedModVersions = state.selectedInstall.mods;
      const { manifestMods } = state.selectedInstall;
      for (let i = 0; i < state.mods.length; i += 1) {
        state.mods[i].isInstalled = !!installedModVersions[state.mods[i].modInfo.mod_reference];
        state.mods[i].manifestVersion = manifestMods.find((mod) => mod.id === state.mods[i].modInfo.mod_reference)?.version;
        state.mods[i].installedVersion = installedModVersions[state.mods[i].modInfo.mod_reference];
        state.mods[i].isDependency = !!installedModVersions[state.mods[i].modInfo.mod_reference] && !manifestMods.some((mod) => mod.id === state.mods[i].modInfo.mod_reference);
        state.mods[i].isCompatible = state.mods[i].modInfo.versions.length > 0
        && !!state.mods[i].modInfo.versions.find((ver) => satisfies(ver.sml_version, '>=2.0.0')
              && state.smlVersions.some((smlVer) => valid(coerce(smlVer.version)) === valid(coerce(ver.sml_version)))
              && satisfies(valid(coerce(state.selectedInstall.version)), `>=${valid(coerce(state.smlVersions.find((smlVer) => valid(coerce(smlVer.version)) === valid(coerce(ver.sml_version))).satisfactory_version))}`));
      }
      state.modFilters[1].mods = state.mods.filter((mod) => mod.isCompatible).length;
      state.modFilters[3].mods = state.mods.filter((mod) => mod.isInstalled).length;
      state.modFilters[4].mods = state.mods.filter((mod) => !mod.isInstalled).length;
    },
    downloadProgress(state, {
      url, progress, name, version,
    }) {
      if (!state.currentDownloadProgress[url]) {
        state.currentDownloadProgress[url] = {
          id: `download_${url}`, progress: 0, message: '', fast: true,
        };
        state.inProgress[0].progresses.push(state.currentDownloadProgress[url]);
      }
      state.currentDownloadProgress[url].message = `Downloading ${limitDownloadNameLength(name)} v${version} ${Math.round(progress.percent * 100)}%`;
      state.currentDownloadProgress[url].progress = progress.percent;
      if (progress.percent === 1) {
        setTimeout(() => {
          state.inProgress[0].progresses.remove(state.currentDownloadProgress[url]);
          delete state.currentDownloadProgress[url];
        }, 100);
      }
    },
    setAvailableMods(state, { mods }) {
      state.mods = mods;
    },
    setExpandedMod(state, { modId }) {
      state.expandedModId = modId;
    },
    clearDownloadProgress(state) {
      state.downloadProgress = [];
    },
    showError(state, { e }) {
      state.error = typeof e === 'string' ? e : e.message;
    },
    launchGame(state) {
      state.isLaunchingGame = true;
      state.isGameRunning = true;
      setTimeout(() => { state.isLaunchingGame = false; }, 10000);
    },
    setGameRunning(state, isGameRunning) {
      state.isGameRunning = isGameRunning;
    },
    setExpandModInfoOnStart(state, value) {
      state.expandModInfoOnStart = value;
    },
  },
  actions: {
    setFilters({ commit }, newFilters) {
      commit('setFilters', { newFilters });
      saveSetting('filters', { modFilters: newFilters.modFilters.name, sortBy: newFilters.sortBy });
    },
    async selectInstall({ commit, dispatch, state }, newInstall) {
      commit('setInstall', { newInstall });
      if (!state.inProgress.some((prog) => prog.id === '__loadingApp__')) {
        const loadProgress = {
          id: '__loadingApp__',
          progresses: [{
            id: '', progress: -1, message: 'Validating mod install', fast: false,
          }],
        };
        state.inProgress.push(loadProgress);
        const savedProfileName = getSetting('selectedProfile', {})[state.selectedInstall.installLocation] || 'modded';
        commit('setProfile', { newProfile: state.profiles.find((conf) => conf.name === savedProfileName) });
        try {
          await newInstall.setProfile(savedProfileName);
          commit('refreshModsInstalledCompatible');
        } catch (e) {
          dispatch('showError', e);
        } finally {
          state.inProgress.remove(loadProgress);
        }
        saveSetting('selectedInstall', newInstall.installLocation);
      }
    },
    async selectProfile({ commit, dispatch, state }, newProfile) {
      commit('setProfile', { newProfile });
      if (!state.inProgress.some((prog) => prog.id === '__loadingApp__')) {
        const loadProgress = {
          id: '__loadingApp__',
          progresses: [{
            id: '', progress: -1, message: 'Validating mod install', fast: false,
          }],
        };
        state.inProgress.push(loadProgress);
        try {
          await state.selectedInstall.setProfile(newProfile.name);
          commit('refreshModsInstalledCompatible');
          let current = getSetting('selectedProfile', {});
          if (typeof current !== 'object') { current = {}; }
          current[state.selectedInstall.installLocation] = state.selectedProfile.name;
          saveSetting('selectedProfile', current);
        } catch (e) {
          dispatch('showError', e);
        } finally {
          state.inProgress.remove(loadProgress);
        }
      }
    },
    async switchModInstalled({ commit, dispatch, state }, modId) {
      if (state.inProgress.length > 0) {
        dispatch('showError', 'Another operation is currently in progress');
        return;
      }
      commit('clearDownloadProgress');
      const modProgress = { id: modId, progresses: [] };
      state.inProgress.push(modProgress);
      const placeholderProgreess = {
        id: 'placeholder', progress: -1, message: '', fast: false,
      };
      modProgress.progresses.push(placeholderProgreess);
      if (state.mods.find((mod) => mod.modInfo.mod_reference === modId).isInstalled) {
        placeholderProgreess.message = 'Checking for mods that are no longer needed';
        try {
          await state.selectedInstall.uninstallMod(modId);
          placeholderProgreess.progress = 1;
          commit('refreshModsInstalledCompatible');
        } catch (e) {
          dispatch('showError', e);
        } finally {
          setTimeout(() => {
            state.inProgress.remove(modProgress);
          }, 500);
        }
      } else {
        placeholderProgreess.message = 'Finding the best version to install';
        try {
          await state.selectedInstall.installMod(modId);
          placeholderProgreess.progress = 1;
          commit('refreshModsInstalledCompatible');
        } catch (e) {
          dispatch('showError', e);
        } finally {
          setTimeout(() => {
            state.inProgress.remove(modProgress);
          }, 500);
        }
      }
    },
    async installModVersion({ commit, dispatch, state }, { modId, version }) {
      if (state.inProgress.length > 0) {
        dispatch('showError', 'Another operation is currently in progress');
        return;
      }
      commit('clearDownloadProgress');
      const modProgress = { id: modId, progresses: [] };
      state.inProgress.push(modProgress);
      const placeholderProgreess = {
        id: 'placeholder', progress: -1, message: '', fast: false,
      };
      modProgress.progresses.push(placeholderProgreess);
      placeholderProgreess.message = `Installing ${version ? `${modId} v${version}` : `latest ${modId}`}`;
      try {
        if (version || !state.mods.find((mod) => mod.modInfo.mod_reference === modId)?.isInstalled) {
          await state.selectedInstall.installMod(modId, version);
        } else {
          await state.selectedInstall.updateMod(modId);
        }
        placeholderProgreess.progress = 1;
        commit('refreshModsInstalledCompatible');
      } catch (e) {
        dispatch('showError', e);
      } finally {
        setTimeout(() => {
          state.inProgress.remove(modProgress);
        }, 500);
      }
    },
    expandMod({ commit }, modId) {
      commit('setExpandedMod', { modId });
      ipcRenderer.send('expand');
    },
    unexpandMod({ commit }) {
      commit('setExpandedMod', { modId: '' });
      ipcRenderer.send('unexpand');
    },
    toggleModFavorite({ state }, modId) {
      if (!state.favoriteModIds.includes(modId)) {
        state.favoriteModIds.push(modId);
      } else {
        state.favoriteModIds.remove(modId);
      }
      state.modFilters[2].mods = state.mods.filter((mod) => state.favoriteModIds.includes(mod.modInfo.mod_reference)).length;
      saveSetting('favoriteMods', state.favoriteModIds);
    },
    createProfile({ dispatch, state }, { profileName, copyCurrent }) {
      createProfile(profileName, copyCurrent ? state.selectedProfile.name : 'vanilla');
      const newProfile = { name: profileName, items: copyCurrent ? state.selectedProfile.items : [] };
      state.profiles.push(newProfile);
      dispatch('selectProfile', newProfile);
    },
    deleteProfile({ dispatch, state }, { profileName }) {
      deleteProfile(profileName);
      state.profiles.removeWhere((profile) => profile.name === profileName);
      if (state.selectedProfile.name === profileName) {
        dispatch('selectProfile', state.profiles.find((profile) => profile.name === 'modded'));
      }
    },
    async initApp({
      commit, dispatch, state, getters,
    }) {
      const appLoadProgress = {
        id: '__loadingApp__',
        progresses: [{
          id: '', progress: -1, message: 'Loading', fast: false,
        }],
      };
      state.inProgress.push(appLoadProgress);
      addDownloadProgressCallback((url, progress, name, version) => commit('downloadProgress', {
        url, progress, name, version,
      }));
      commit('setFavoriteModIds', { favoriteModIds: getSetting('favoriteMods', []) });
      commit('setProfiles', { profiles: getProfiles() });
      commit('setExpandModInfoOnStart', getSetting('expandModInfoOnStart', false));

      const savedFilters = getSetting('filters', { modFilters: state.modFilters[1].name, sortBy: state.filters.sortBy[0] }); // default Compatible, Last Updated
      commit('setFilters', {
        newFilters: {
          modFilters: state.modFilters.find((modFilter) => modFilter.name === savedFilters.modFilters) || state.modFilters[1], // default Compatible
          sortBy: state.sortBy.find((item) => item === savedFilters.sortBy) || state.sortBy[0], // default Last Updated
          search: '',
        },
      });
      try {
        await Promise.all([
          (async () => {
            await loadCache();
            const { installs, invalidInstalls } = await getInstalls();
            if (installs.length === 0) {
              if (invalidInstalls.length !== 0) {
                if (invalidInstalls.length > 1) {
                  throw new Error(`${invalidInstalls.length} Satisfactory installs were found, but all of them point to folders that don't exist.`);
                }
                throw new Error(`${invalidInstalls.length} Satisfactory install was found, but it points to a folder that doesn't exist.`);
              }
              throw new Error('No Satisfactory installs found.');
            }
            commit('setInstalls', { installs });
            const installValidateProgress = { id: 'validatingInstall', progress: -1, message: 'Validating mod install' };
            appLoadProgress.progresses.push(installValidateProgress);
            const savedLocation = getSetting('selectedInstall');
            commit('setInstall', { newInstall: state.satisfactoryInstalls.find((install) => install.installLocation === savedLocation) || state.satisfactoryInstalls[0] });
            const savedProfileName = getSetting('selectedProfile', {})[state.selectedInstall.installLocation] || 'modded';
            commit('setProfile', { newProfile: state.profiles.find((conf) => conf.name === savedProfileName) });

            await state.selectedInstall.setProfile(savedProfileName);
            appLoadProgress.progresses.remove(installValidateProgress);
          })(),
          (async () => {
            commit('setSMLVersions', { smlVersions: await getAvailableSMLVersions() });
          })(),
          dispatch('getAllMods', { progress: appLoadProgress }),
        ]);
      } catch (e) {
        dispatch('showError', e);
      } finally {
        state.modFilters[0].mods = state.mods.length;
        state.modFilters[2].mods = state.mods.filter((mod) => state.favoriteModIds.includes(mod.modInfo.mod_reference)).length;
        commit('refreshModsInstalledCompatible');
        state.inProgress.remove(appLoadProgress);
        if (state.expandModInfoOnStart) {
          dispatch('expandMod', getters.filteredMods[0].modInfo.mod_reference);
        }
      }
      setInterval(async () => {
        commit('setGameRunning', state.isLaunchingGame || await SatisfactoryInstall.isGameRunning());
      }, 5000);
    },
    async getAllMods({ commit }, { progress }) {
      const getModsProgress = { id: 'getMods', progress: -1, message: 'Getting available mods' };
      if (progress) {
        progress.progresses.push(getModsProgress);
      }
      let modsGot = 0;
      const modCount = await getModsCount();
      getModsProgress.message = `Getting available mods (${modsGot}/${modCount})`;
      getModsProgress.progress = 0;
      const modPages = Math.ceil(modCount / MODS_PER_PAGE);
      const mods = (await Promise.all(Array.from({ length: modPages }).map(async (_, i) => {
        const page = await getAvailableMods(i);
        modsGot += page.length;
        getModsProgress.progress += 1 / modPages;
        getModsProgress.message = `Getting available mods (${modsGot}/${modCount})`;
        return page;
      }))).flat(1);
      commit('setAvailableMods', {
        mods: mods.map((mod) => ({
          modInfo: mod,
          isInstalled: false,
          isCompatible: true,
          isDependency: false,
        })),
      });
      if (progress) {
        progress.progresses.remove(getModsProgress);
      }
    },
    showError({ commit }, e) {
      commit('showError', { e });
      // eslint-disable-next-line no-console
      console.error(e);
    },
    clearError({ commit }) {
      commit('showError', { e: '' });
    },
    setExpandModInfoOnStart({ commit }, value) {
      commit('setExpandModInfoOnStart', value);
      saveSetting('expandModInfoOnStart', value);
    },
    async updateSingle({ state, commit, dispatch }, update) {
      const updateProgress = {
        id: update.item,
        progresses: [],
      };
      const placeholderProgreess = {
        id: '', progress: -1, message: `Updating ${update.item} to v${update.version}`, fast: false,
      };
      updateProgress.progresses.push(placeholderProgreess);
      state.inProgress.push(updateProgress);
      try {
        await state.selectedInstall.manifestMutate([], [], [update.item]);
        placeholderProgreess.progress = 1;
        commit('refreshModsInstalledCompatible');
      } catch (e) {
        dispatch('showError', e);
      } finally {
        setTimeout(() => {
          state.inProgress.remove(updateProgress);
        }, 500);
      }
    },
    async updateMulti({ state, commit, dispatch }, updates) {
      const updateProgress = {
        id: '__updateMods__',
        progresses: [],
      };
      const placeholderProgreess = {
        id: '', progress: -1, message: `Updating ${updates.length} mod${updates.length > 1 ? 's' : ''}`, fast: false,
      };
      updateProgress.progresses.push(placeholderProgreess);
      state.inProgress.push(updateProgress);
      try {
        await state.selectedInstall.manifestMutate([], [], updates.map((update) => update.item));
        placeholderProgreess.progress = 1;
        commit('refreshModsInstalledCompatible');
      } catch (e) {
        dispatch('showError', e);
      } finally {
        setTimeout(() => {
          state.inProgress.remove(updateProgress);
        }, 500);
      }
    },
  },
  getters: {
    filteredMods(state) {
      let filtered;
      if (state.filters.modFilters === state.modFilters[1]) filtered = state.mods.filter((mod) => mod.isCompatible);
      else if (state.filters.modFilters === state.modFilters[2]) filtered = state.mods.filter((mod) => state.favoriteModIds.includes(mod.modInfo.mod_reference));
      else if (state.filters.modFilters === state.modFilters[3]) filtered = state.mods.filter((mod) => mod.isInstalled);
      else if (state.filters.modFilters === state.modFilters[4]) filtered = state.mods.filter((mod) => !mod.isInstalled);
      else filtered = [...state.mods];

      if (state.filters.search !== '') {
        filtered = filtered.filter((mod) => mod.modInfo.name.toLowerCase().includes(state.filters.search.toLowerCase())); // TODO: maybe search in description too
      }

      if (state.filters.sortBy === 'Name') filtered = filtered.sort((a, b) => a.modInfo.name.localeCompare(b.modInfo.name));
      if (state.filters.sortBy === 'Last updated') filtered = filtered.sort((a, b) => b.modInfo.last_version_date - a.modInfo.last_version_date);
      if (state.filters.sortBy === 'Popularity') filtered = filtered.sort((a, b) => b.modInfo.popularity - a.modInfo.popularity);
      if (state.filters.sortBy === 'Hotness') filtered = filtered.sort((a, b) => b.modInfo.hotness - a.modInfo.hotness);
      if (state.filters.sortBy === 'Views') filtered = filtered.sort((a, b) => b.modInfo.views - a.modInfo.views);
      if (state.filters.sortBy === 'Downloads') filtered = filtered.sort((a, b) => b.modInfo.downloads - a.modInfo.downloads);

      return filtered;
    },
    canInstallMods(state) {
      return state.selectedProfile.name !== 'vanilla' && !state.isGameRunning;
    },
  },
});
