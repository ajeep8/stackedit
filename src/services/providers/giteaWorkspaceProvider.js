import store from '../../store';
import giteaHelper from './helpers/giteaHelper';
import Provider from './common/Provider';
import utils from '../utils';
import userSvc from '../userSvc';
import gitWorkspaceSvc from '../gitWorkspaceSvc';
import badgeSvc from '../badgeSvc';

const getAbsolutePath = ({ id }) =>
  `${store.getters['workspace/currentWorkspace'].path || ''}${id}`;

export default new Provider({
  id: 'giteaWorkspace',
  name: 'Gitea',
  getToken() {
    return store.getters['workspace/syncToken'];
  },
  getWorkspaceParams({
    serverUrl,
    projectPath,
    branch,
    path,
  }) {
    return {
      providerId: this.id,
      serverUrl,
      projectPath,
      branch,
      path,
    };
  },
  getWorkspaceLocationUrl({
    serverUrl,
    projectPath,
    branch,
    path,
  }) {
    return `${serverUrl}/${projectPath}/src/branch/${encodeURIComponent(branch)}/${utils.encodeUrlPath(path)}`;
  },
  getSyncDataUrl({ id }) {
    const { projectPath, branch } = store.getters['workspace/currentWorkspace'];
    const { serverUrl } = this.getToken();
    return `${serverUrl}/${projectPath}/src/branch/${encodeURIComponent(branch)}/${utils.encodeUrlPath(getAbsolutePath({ id }))}`;
  },
  getSyncDataDescription({ id }) {
    return getAbsolutePath({ id });
  },
  async initWorkspace() {
    const { serverUrl, branch } = utils.queryParams;
    const workspaceParams = this.getWorkspaceParams({ serverUrl, branch });
    if (!branch) {
      workspaceParams.branch = 'master';
    }

    // Extract project path param
    const projectPath = (utils.queryParams.projectPath || '')
      .trim()
      .replace(/^\/*/, '') // Remove leading `/`
      .replace(/\/*$/, ''); // Remove trailing `/`
    workspaceParams.projectPath = projectPath;

    // Extract path param
    const path = (utils.queryParams.path || '')
      .trim()
      .replace(/^\/*/, '') // Remove leading `/`
      .replace(/\/*$/, '/'); // Add trailing `/`
    if (path !== '/') {
      workspaceParams.path = path;
    }

    const workspaceId = utils.makeWorkspaceId(workspaceParams);
    const workspace = store.getters['workspace/workspacesById'][workspaceId];

    // See if we already have a token
    const sub = workspace ? workspace.sub : utils.queryParams.sub;
    let token = store.getters['data/giteaTokensBySub'][sub];
    if (!token) {
      const applicationInfo = await store.dispatch('modal/open', {
        type: 'giteaAccount',
        forceServerUrl: serverUrl,
      });
      token = await giteaHelper.addAccount(applicationInfo, sub);
    }

    if (!workspace) {
      const projectId = await giteaHelper.getProjectId(token, workspaceParams);
      const pathEntries = (path || '').split('/');
      const projectPathEntries = (projectPath || '').split('/');
      const name = pathEntries[pathEntries.length - 2] // path ends with `/`
        || projectPathEntries[projectPathEntries.length - 1];
      store.dispatch('workspace/patchWorkspacesById', {
        [workspaceId]: {
          ...workspaceParams,
          projectId,
          id: workspaceId,
          sub: token.sub,
          name,
        },
      });
    }

    badgeSvc.addBadge('addGiteaWorkspace');
    return store.getters['workspace/workspacesById'][workspaceId];
  },
  getChanges() {
    return giteaHelper.getTree({
      ...store.getters['workspace/currentWorkspace'],
      token: this.getToken(),
    });
  },
  prepareChanges(tree) {
    return gitWorkspaceSvc.makeChanges(tree.tree.map(entry => ({
      ...entry,
      id: entry.sha,
    })));
  },
  async saveWorkspaceItem({ item }) {
    const syncData = {
      id: store.getters.gitPathsByItemId[item.id],
      type: item.type,
      hash: item.hash,
    };

    // Files and folders are not in git, only contents
    if (item.type === 'file' || item.type === 'folder') {
      return { syncData };
    }

    // locations are stored as paths, so we upload an empty file
    const syncToken = store.getters['workspace/syncToken'];
    await giteaHelper.uploadFile({
      ...store.getters['workspace/currentWorkspace'],
      token: syncToken,
      path: getAbsolutePath(syncData),
      content: '',
      sha: gitWorkspaceSvc.shaByPath[syncData.id],
      commitMessage: item.commitMessage,
    });

    // Return sync data to save
    return { syncData };
  },
  async removeWorkspaceItem({ syncData }) {
    if (gitWorkspaceSvc.shaByPath[syncData.id]) {
      const syncToken = store.getters['workspace/syncToken'];
      await giteaHelper.removeFile({
        ...store.getters['workspace/currentWorkspace'],
        token: syncToken,
        path: getAbsolutePath(syncData),
        sha: gitWorkspaceSvc.shaByPath[syncData.id],
      });
    }
  },
  async downloadWorkspaceContent({
    token,
    contentId,
    contentSyncData,
    fileSyncData,
  }) {
    const { sha, data } = await giteaHelper.downloadFile({
      ...store.getters['workspace/currentWorkspace'],
      token,
      path: getAbsolutePath(fileSyncData),
    });
    gitWorkspaceSvc.shaByPath[fileSyncData.id] = sha;
    const content = Provider.parseContent(data, contentId);
    return {
      content,
      contentSyncData: {
        ...contentSyncData,
        hash: content.hash,
        sha,
      },
    };
  },
  async downloadWorkspaceData({ token, syncData }) {
    if (!syncData) {
      return {};
    }

    const { sha, data } = await giteaHelper.downloadFile({
      ...store.getters['workspace/currentWorkspace'],
      token,
      path: getAbsolutePath(syncData),
    });
    gitWorkspaceSvc.shaByPath[syncData.id] = sha;
    const item = JSON.parse(data);
    return {
      item,
      syncData: {
        ...syncData,
        hash: item.hash,
        sha,
      },
    };
  },
  async uploadWorkspaceContent({
    token,
    content,
    file,
    commitMessage,
  }) {
    const path = store.getters.gitPathsByItemId[file.id];
    const absolutePath = `${store.getters['workspace/currentWorkspace'].path || ''}${path}`;
    const sha = gitWorkspaceSvc.shaByPath[path];
    await giteaHelper.uploadFile({
      ...store.getters['workspace/currentWorkspace'],
      token,
      path: absolutePath,
      content: Provider.serializeContent(content),
      sha,
      commitMessage,
    });

    // Return new sync data
    return {
      contentSyncData: {
        id: store.getters.gitPathsByItemId[content.id],
        type: content.type,
        hash: content.hash,
        sha,
      },
      fileSyncData: {
        id: path,
        type: 'file',
        hash: file.hash,
      },
    };
  },
  async uploadWorkspaceData({ token, item }) {
    const path = store.getters.gitPathsByItemId[item.id];
    const syncData = {
      id: path,
      type: item.type,
      hash: item.hash,
    };
    const res = await giteaHelper.uploadFile({
      ...store.getters['workspace/currentWorkspace'],
      token,
      path: getAbsolutePath(syncData),
      content: JSON.stringify(item),
      sha: gitWorkspaceSvc.shaByPath[path],
    });

    return {
      syncData: {
        ...syncData,
        sha: res.content.sha,
      },
    };
  },
  async listFileRevisions({ token, fileSyncDataId }) {
    const { projectId, branch } = store.getters['workspace/currentWorkspace'];
    const entries = await giteaHelper.getCommits({
      token,
      projectId,
      sha: branch,
      path: getAbsolutePath({ id: fileSyncDataId }),
    });

    return entries.map(({
      author,
      committer,
      commit,
      sha,
    }) => {
      let user;
      if (author && author.login) {
        user = author;
      } else if (committer && committer.login) {
        user = committer;
      }
      const sub = `${giteaHelper.subPrefix}:${user.login}`;
      userSvc.addUserInfo({ id: sub, name: user.login, imageUrl: user.avatar_url });
      const date = (commit.author && commit.author.date)
        || (commit.committer && commit.committer.date)
        || 1;
      return {
        id: sha,
        sub,
        message: commit.message,
        created: new Date(date).getTime(),
      };
    });
  },
  async loadFileRevision() {
    // Revisions are already loaded
    return false;
  },
  async getFileRevisionContent({
    token,
    contentId,
    fileSyncDataId,
    revisionId,
  }) {
    const { data } = await giteaHelper.downloadFile({
      ...store.getters['workspace/currentWorkspace'],
      token,
      branch: revisionId,
      path: getAbsolutePath({ id: fileSyncDataId }),
    });
    return Provider.parseContent(data, contentId);
  },
});
