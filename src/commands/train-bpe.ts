import { trainBPEFromDatabase, loadBPEVocab, getLastBPETrainTime } from '../lib/bpe.js';

interface TrainBPEOptions {
  vocabSize?: number;
  minFrequency?: number;
  showStats?: boolean;
}

export async function trainBPE(options: TrainBPEOptions = {}): Promise<void> {
  const { vocabSize = 5000, minFrequency = 2, showStats = false } = options;

  if (showStats) {
    // Just show current BPE stats
    const vocab = loadBPEVocab();
    const lastTrained = getLastBPETrainTime();

    if (!vocab) {
      console.log('No BPE vocabulary trained yet.');
      console.log('Run `succ train-bpe` to train from indexed code.');
      return;
    }

    console.log('BPE Vocabulary Statistics:');
    console.log(`  Vocabulary size: ${vocab.vocabSize}`);
    console.log(`  Merge operations: ${vocab.merges.length}`);
    console.log(`  Trained from: ${vocab.corpusSize.toLocaleString()} tokens`);
    console.log(`  Last trained: ${lastTrained || vocab.trainedAt}`);
    return;
  }

  console.log('Training BPE vocabulary from indexed code...');
  console.log(`  Target vocab size: ${vocabSize}`);
  console.log(`  Min frequency: ${minFrequency}`);
  console.log('');

  const vocab = await trainBPEFromDatabase(vocabSize, minFrequency);

  if (!vocab) {
    console.log('BPE training skipped (no code indexed or not enough tokens).');
    return;
  }

  console.log('');
  console.log('BPE training complete!');
  console.log(`  Final vocabulary size: ${vocab.vocabSize}`);
  console.log(`  Merge operations: ${vocab.merges.length}`);
  console.log(`  Trained from: ${vocab.corpusSize.toLocaleString()} tokens`);
}
