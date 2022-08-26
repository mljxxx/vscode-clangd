import { existsSync, readFileSync, realpathSync } from 'fs';
import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';

import * as ast from './ast';
import * as config from './config';
import * as configFileWatcher from './config-file-watcher';
import * as fileStatus from './file-status';
import * as inlayHints from './inlay-hints';
import * as install from './install';
import * as memoryUsage from './memory-usage';
import * as openConfig from './open-config';
import * as switchSourceHeader from './switch-source-header';
import * as typeHierarchy from './type-hierarchy';
import * as customFileWatcher from './custom-file-watcher'

export const clangdDocumentSelector = [
  {scheme: 'file', language: 'c'},
  {scheme: 'file', language: 'cpp'},
  {scheme: 'file', language: 'cuda-cpp'},
  {scheme: 'file', language: 'objective-c'},
  {scheme: 'file', language: 'objective-cpp'},
];

export function isClangdDocument(document: vscode.TextDocument) {
  return vscode.languages.match(clangdDocumentSelector, document);
}

class ClangdLanguageClient extends vscodelc.LanguageClient {
  // Override the default implementation for failed requests. The default
  // behavior is just to log failures in the output panel, however output panel
  // is designed for extension debugging purpose, normal users will not open it,
  // thus when the failure occurs, normal users doesn't know that.
  //
  // For user-interactive operations (e.g. applyFixIt, applyTweaks), we will
  // prompt up the failure to users.

  handleFailedRequest<T>(type: vscodelc.MessageSignature, error: any,
                         token: vscode.CancellationToken|undefined,
                         defaultValue: T): T {
    if (error instanceof vscodelc.ResponseError &&
        type.method === 'workspace/executeCommand')
      vscode.window.showErrorMessage(error.message);

    return super.handleFailedRequest(type, token, error, defaultValue);
  }
}

class EnableEditsNearCursorFeature implements vscodelc.StaticFeature {
  initialize() {}
  fillClientCapabilities(capabilities: vscodelc.ClientCapabilities): void {
    const extendedCompletionCapabilities: any =
        capabilities.textDocument?.completion;
    extendedCompletionCapabilities.editsNearCursor = true;
  }
  getState(): vscodelc.FeatureState { return {kind: 'static'}; }
  dispose() {}
}

export class ClangdContext implements vscode.Disposable {
  subscriptions: vscode.Disposable[] = [];
  client!: ClangdLanguageClient;
  completionPrefixMap: trieNode = new trieNode(undefined);
  completionPrefixMapPath: string = "";
  async activate(globalStoragePath: string, outputChannel: vscode.OutputChannel,
                 workspaceState: vscode.Memento) {
    const clangdPath =
        await install.activate(this, globalStoragePath, workspaceState);
    if (!clangdPath)
      return;

    const clangd: vscodelc.Executable = {
      command: clangdPath,
      args:
          await config.getSecureOrPrompt<string[]>('arguments', workspaceState),
      options: {cwd: vscode.workspace.rootPath || process.cwd()}
    };
    const traceFile = config.get<string>('trace');
    if (!!traceFile) {
      const trace = {CLANGD_TRACE: traceFile};
      clangd.options = {env: {...process.env, ...trace}};
    }
    const serverOptions: vscodelc.ServerOptions = clangd;
    this.updateCompletionPrefixMap();

    const clientOptions: vscodelc.LanguageClientOptions = {
      // Register the server for c-family and cuda files.
      documentSelector: clangdDocumentSelector,
      initializationOptions: {
        clangdFileStatus: true,
        fallbackFlags: config.get<string[]>('fallbackFlags')
      },
      outputChannel: outputChannel,
      // Do not switch to output window when clangd returns output.
      revealOutputChannelOn: vscodelc.RevealOutputChannelOn.Never,

      // We hack up the completion items a bit to prevent VSCode from re-ranking
      // and throwing away all our delicious signals like type information.
      //
      // VSCode sorts by (fuzzymatch(prefix, item.filterText), item.sortText)
      // By adding the prefix to the beginning of the filterText, we get a
      // perfect
      // fuzzymatch score for every item.
      // The sortText (which reflects clangd ranking) breaks the tie.
      // This also prevents VSCode from filtering out any results due to the
      // differences in how fuzzy filtering is applies, e.g. enable dot-to-arrow
      // fixes in completion.
      //
      // We also mark the list as incomplete to force retrieving new rankings.
      // See https://github.com/microsoft/language-server-protocol/issues/898
      middleware: {
        provideCompletionItem: async (document, position, context, token,
                                      next) => {
          let list = await next(document,position, context, token);
          if (!config.get<boolean>('serverCompletionRanking'))
            return list;
          let items = (Array.isArray(list) ? list : list!.items).map(item => {
            // Gets the prefix used by VSCode when doing fuzzymatch.
            let prefix = document.getText(
                new vscode.Range((item.range as vscode.Range).start, position))
            if (prefix)
            item.filterText = prefix + '_' + item.filterText;
            let insertText : vscode.SnippetString | string | undefined = item.insertText;
            if(insertText instanceof vscode.SnippetString) {
              let pattern = RegExp(/:(\(.*?\))\(.*?\)/);
              let returnValue: RegExpExecArray | null = null;
              if(returnValue = pattern.exec(insertText.value)) {
                insertText.value = returnValue[1] + insertText.value.replace(returnValue[1],'');
                item.insertText = insertText;
              }
            }
            // Workaround for https://github.com/clangd/vscode-clangd/issues/357
            // clangd's used of commit-characters was well-intentioned, but
            // overall UX is poor. Due to vscode-languageclient bugs, we didn't
            // notice until the behavior was in several releases, so we need
            // to override it on the client.
            item.commitCharacters = [];
            return item;
          })
          return new vscode.CompletionList(items, /*isIncomplete=*/ true);
        },
        provideDefinition: async (document, position, token, provideDefinition) => {
          let result = await provideDefinition(document,position, token);
          if(Array.isArray(result) && result.length > 0) {
            let list : vscode.Location[] | vscode.LocationLink[] = result;
            let item = list[0];
            if(item instanceof vscode.Location) {
              if (item.uri.path !== undefined) {
                let filePath = realpathSync(item.uri.path)
                let prefixAndReplacePath = this.getPrefixPathAndReplacePathWithPath(filePath);
                if(prefixAndReplacePath !== undefined) {
                  let [prefixPath, replacePath] = prefixAndReplacePath;
                  let resolvePath = filePath.replace(prefixPath,replacePath);
                  if(existsSync(resolvePath)) {
                    item.uri = item.uri?.with({ path: resolvePath });
                  }
                }
              } 
              return item;
            } else {

            }
          }
          return result;
        },
        provideDocumentLinks: async(document, token, provideDocumentLinks) => {
          let result = await provideDocumentLinks(document, token);
          if(Array.isArray(result) && result.length > 0) {
            result = result.map(item => {
              if (item.target?.path !== undefined) {
                let filePath = realpathSync(item.target.path)
                let prefixAndReplacePath = this.getPrefixPathAndReplacePathWithPath(filePath);
                if(prefixAndReplacePath !== undefined) {
                  let [prefixPath, replacePath] = prefixAndReplacePath;
                  let resolvePath = filePath.replace(prefixPath,replacePath);
                  if(existsSync(resolvePath)) {
                    item.target = item.target?.with({ path: resolvePath });
                  }
                }
              } 
              return item;
            })
          }
          return result;
        },
        // VSCode applies fuzzy match only on the symbol name, thus it throws
        // away all results if query token is a prefix qualified name.
        // By adding the containerName to the symbol name, it prevents VSCode
        // from filtering out any results, e.g. enable workspaceSymbols for
        // qualified symbols.
        provideWorkspaceSymbols: async (query, token, next) => {
          let symbols = await next(query, token);
          return symbols?.map(symbol => {
            // Only make this adjustment if the query is in fact qualified.
            // Otherwise, we get a suboptimal ordering of results because
            // including the name's qualifier (if it has one) in symbol.name
            // means vscode can no longer tell apart exact matches from
            // partial matches.
            if (query.includes('::')) {
              if (symbol.containerName)
                symbol.name = `${symbol.containerName}::${symbol.name}`;
              // Clean the containerName to avoid displaying it twice.
              symbol.containerName = '';
            }
            return symbol;
          })
        },
      },
    };

    this.client = new ClangdLanguageClient('Clang Language Server',
                                           serverOptions, clientOptions);
    this.client.clientOptions.errorHandler =
        this.client.createDefaultErrorHandler(
            // max restart count
            config.get<boolean>('restartAfterCrash') ? /*default*/ 4 : 0);
    this.client.registerFeature(new EnableEditsNearCursorFeature);
    typeHierarchy.activate(this);
    inlayHints.activate(this);
    memoryUsage.activate(this);
    ast.activate(this);
    openConfig.activate(this);
    this.client.start();
    console.log('Clang Language Server is now active!');
    fileStatus.activate(this);
    switchSourceHeader.activate(this);
    configFileWatcher.activate(this);
    customFileWatcher.activate(this);
  }

  get visibleClangdEditors(): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter(
        (e) => isClangdDocument(e.document));
  }
  updateCompletionPrefixMap() {
      let completionPrefixMapPath = this.completionPrefixMapPath.concat("/completion_prefix_map.json");
      if (existsSync(completionPrefixMapPath)) {
        let completionPrefixMap = JSON.parse(readFileSync(completionPrefixMapPath, "utf-8"));
        for (const key in completionPrefixMap) {
          let prefixPath = key, replacePath = completionPrefixMap[key];
          let node: trieNode | undefined = this.completionPrefixMap;
          let prefixPathComponentArray = prefixPath.split("/");
          for (const component of prefixPathComponentArray) {
              if (!node!.next.has(component)) {
                node!.next.set(component, new trieNode(undefined));
              }
              node = node!.next.get(component)
          }
          node!.value = replacePath;
        }
    }
  }
  getPrefixPathAndReplacePathWithPath(filePath: string): [string,string] | undefined {
    let filePathComponentArray = filePath.split("/");
    let node: trieNode | undefined = this.completionPrefixMap;
    let prefixPathComponentArray: string[] = [];
    for (const component of filePathComponentArray) {
      if (node!.next.has(component)) {
        prefixPathComponentArray.push(component);
        node = node!.next.get(component);
      }
    }
    let prefixPath = prefixPathComponentArray.join('/');
    if(node!.value) {
      return [prefixPath,node!.value];    
    } else {
      return undefined;
    }
  }

  dispose() {
    this.subscriptions.forEach((d) => { d.dispose(); });
    this.client.stop();
    this.subscriptions = []
  }
}

class trieNode {
  next!: Map<string, trieNode>;
  value: string | undefined;
  constructor(value:string | undefined) {
    this.next = new Map<string, trieNode>();
    this.value = value;
  }
}
