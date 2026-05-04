import {OllamaEmbeddings} from '@langchain/ollama';
import {Chroma} from '@langchain/community/vectorstores/chroma';
import {RecursiveCharacterTextSplitter} from '@langchain/textsplitters';
import {Document} from '@langchain/core/documents';
import {readFileSync} from 'fs';
import logger from '../lib/logger.js';

const COLLECTION_NAME = 'expressive_face_docs';

function buildEmbeddings(): OllamaEmbeddings {
  return new OllamaEmbeddings({
    baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    model: process.env.EMBED_MODEL ?? 'nomic-embed-text',
  });
}

async function getVectorStore(): Promise<Chroma> {
  return Chroma.fromExistingCollection(buildEmbeddings(), {
    collectionName: COLLECTION_NAME,
    url: 'http://localhost:8001',
    collectionMetadata: {'hnsw:space': 'cosine'},
  });
}

export async function getRelevantContext(query: string): Promise<string> {
  try {
    const store = await getVectorStore();
    const retriever = store.asRetriever({k: 3});
    const docs = await retriever.invoke(query);

    if (docs.length === 0) return '';

    return docs.map((d: Document) => d.pageContent).join('\n\n');
  } catch (err) {
    logger.warn({err}, 'RAG retrieval failed — proceeding without context');
    return '';
  }
}

export async function ingestDocuments(sourcePath: string): Promise<void> {
  logger.info({sourcePath}, 'Starting document ingestion');

  const raw = readFileSync(sourcePath, 'utf-8');
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 512,
    chunkOverlap: 64,
  });

  const docs = await splitter.createDocuments([raw]);

  await Chroma.fromDocuments(docs, buildEmbeddings(), {
    collectionName: COLLECTION_NAME,
    url: 'http://localhost:8001',
  });

  logger.info({count: docs.length}, 'Document ingestion complete');
}
