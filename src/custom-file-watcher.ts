import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';
import * as fs from 'fs'
import {ClangdContext} from './clangd-context';
import * as config from './config';

export function activate(context: ClangdContext) {
  if (config.get<string>('onConfigChanged') !== 'ignore') {
    context.client.registerFeature(new CustomFileWatcherFeature(context));
  }
}

class CustomFileWatcherFeature implements vscodelc.StaticFeature {
  constructor(private context: ClangdContext) {}
  fillClientCapabilities(capabilities: vscodelc.ClientCapabilities) {}

  initialize(capabilities: vscodelc.ServerCapabilities,
             _documentSelector: vscodelc.DocumentSelector|undefined) {
    this.context.subscriptions.push(new CustomFileWatcher(this.context));
  }
  getState(): vscodelc.FeatureState { return {kind: 'static'}; }
  dispose() {}
}

class CustomFileWatcher implements vscode.Disposable {
  private fileWatcher?: vscode.FileSystemWatcher;
  private debounceTimer?: NodeJS.Timer;

  dispose() {
    if (this.fileWatcher)
      this.fileWatcher.dispose();
  }

  constructor(private context: ClangdContext) {
    this.createFileSystemWatcher();
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(
        () => { this.createFileSystemWatcher(); }));
  }

  createFileSystemWatcher() {
    if (this.fileWatcher)
      this.fileWatcher.dispose();
    let completionPrefixMapPath = this.context.completionPrefixMapPath.concat("/completion_prefix_map.json");
    if (fs.existsSync(completionPrefixMapPath)) {
      this.fileWatcher = vscode.workspace.createFileSystemWatcher(completionPrefixMapPath);
      this.context.subscriptions.push(this.fileWatcher.onDidChange(
        this.debouncedHandleConfigFilesChanged.bind(this)));
      this.context.subscriptions.push(this.fileWatcher.onDidCreate(
        this.debouncedHandleConfigFilesChanged.bind(this)));
      this.context.subscriptions.push(this.fileWatcher);
    }
  }
    
  async debouncedHandleConfigFilesChanged(uri: vscode.Uri) {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      await this.handleConfigFilesChanged(uri);
      this.debounceTimer = undefined;
    }, 2000);
  }

  async handleConfigFilesChanged(uri: vscode.Uri) {
    // Sometimes the tools that generate the compilation database, before
    // writing to it, they create a new empty file or they clear the existing
    // one, and after the compilation they write the new content. In this cases
    // the server is not supposed to restart
    if ((await vscode.workspace.fs.stat(uri)).size <= 0)
      return;

    switch (config.get<string>('onConfigChanged')) {
    case 'restart':
      // vscode.commands.executeCommand('clangd.restart');
      break;
    case 'ignore':
      break;
    case 'prompt':
    default:
      this.context.updateCompletionPrefixMap();
      break;
    }
  }
}