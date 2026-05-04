import 'dotenv/config';
import {ingestDocuments} from '../services/rag.service.js';

const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error('Usage: tsx src/scripts/ingest.ts <path-to-file>');
  process.exit(1);
}

await ingestDocuments(sourcePath);
console.log('Ingestion complete.');
