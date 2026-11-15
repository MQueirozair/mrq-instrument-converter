//! Leitura e validação de um pacote `.mrq` já existente. Regra central deste
//! módulo: **nenhum offset/tamanho vindo do arquivo é confiado sem antes
//! checar limites e possíveis estouros de inteiro** contra o tamanho real do
//! arquivo em disco — um `.mrq` corrompido ou adulterado nunca deve
//! conseguir fazer o leitor alocar memória absurda, ler fora do arquivo, ou
//! sofrer overflow em aritmética de offset.

use std::io::{Read, Seek, SeekFrom};

use sha2::{Digest, Sha256};

use super::errors::MrqError;
use super::format;
use super::model::{MrqDecodedSample, MrqFileMetadata, MrqIntegrityReport, MrqSampleIndexEntry, MrqSampleIntegrity};

struct ValidatedHeader {
    total_len: u64,
    metadata_len: u64,
}

/// Lê e valida só o cabeçalho fixo (16 bytes): assinatura, versão, e que o
/// `metadata_len` declarado cabe no arquivo (com uma folga mínima pro
/// rodapé de 32 bytes) — tudo ANTES de alocar o buffer de metadados.
fn open_and_validate_header(path: &std::path::Path) -> Result<(std::fs::File, ValidatedHeader), MrqError> {
    let mut file = std::fs::File::open(path)?;
    let total_len = file.metadata()?.len();

    if total_len < format::MIN_FILE_LEN {
        return Err(MrqError::Truncated { needed_at_least: format::MIN_FILE_LEN, available: total_len });
    }

    let mut header = [0u8; format::HEADER_FIXED_LEN as usize];
    file.read_exact(&mut header)?;

    if header[0..4] != format::MAGIC {
        return Err(MrqError::InvalidMagic);
    }

    let version = u32::from_le_bytes(header[4..8].try_into().expect("slice de 4 bytes"));
    if version != format::CURRENT_VERSION {
        return Err(MrqError::UnsupportedVersion { found: version, expected: format::CURRENT_VERSION });
    }

    let metadata_len = u64::from_le_bytes(header[8..16].try_into().expect("slice de 8 bytes"));
    let max_allowed_by_file = total_len.saturating_sub(format::HEADER_FIXED_LEN + format::TRAILER_LEN);
    if metadata_len > format::MAX_REASONABLE_METADATA_LEN || metadata_len > max_allowed_by_file {
        return Err(MrqError::MetadataLenExceedsFile {
            declared: metadata_len,
            max_allowed: max_allowed_by_file.min(format::MAX_REASONABLE_METADATA_LEN),
        });
    }

    Ok((file, ValidatedHeader { total_len, metadata_len }))
}

/// Lê e valida COMPLETAMENTE os metadados — inclusive os offsets/tamanhos de
/// TODAS as amostras do índice, contra limites e estouro de inteiro — antes
/// de qualquer amostra ser de fato lida por qualquer outra função deste
/// módulo. Nenhuma outra função pula essa validação (todas chamam esta
/// primeiro).
pub fn read_file_metadata(path: &std::path::Path) -> Result<MrqFileMetadata, MrqError> {
    let (mut file, header) = open_and_validate_header(path)?;

    let mut metadata_bytes = vec![0u8; header.metadata_len as usize];
    file.read_exact(&mut metadata_bytes)?;

    let file_metadata: MrqFileMetadata = serde_json::from_slice(&metadata_bytes)
        .map_err(|e| MrqError::InvalidMetadataJson { message: e.to_string() })?;

    let sample_block_start = format::HEADER_FIXED_LEN + header.metadata_len;
    let sample_block_end = header.total_len - format::TRAILER_LEN;

    for entry in &file_metadata.samples {
        let abs_offset = sample_block_start
            .checked_add(entry.relative_offset)
            .ok_or_else(|| MrqError::SizeOverflow { sample_id: entry.id.clone() })?;
        let abs_end = abs_offset
            .checked_add(entry.length)
            .ok_or_else(|| MrqError::SizeOverflow { sample_id: entry.id.clone() })?;
        if abs_offset < sample_block_start || abs_end > sample_block_end {
            return Err(MrqError::OffsetOutOfBounds { sample_id: entry.id.clone() });
        }
    }

    Ok(file_metadata)
}

pub fn read_sample_index(path: &std::path::Path) -> Result<Vec<MrqSampleIndexEntry>, MrqError> {
    Ok(read_file_metadata(path)?.samples)
}

/// Abre o arquivo já validado e devolve o handle + o offset absoluto onde
/// começa o bloco de amostras (cabeçalho fixo + metadados) — usado por
/// `writer::rebuild_with_model` (v0.2.21) pra copiar os bytes FLAC de cada
/// amostra verbatim, sem reparsear nem revalidar nada a cada amostra.
pub(crate) fn open_for_sample_copy(path: &std::path::Path) -> Result<(std::fs::File, u64), MrqError> {
    let (file, header) = open_and_validate_header(path)?;
    Ok((file, format::HEADER_FIXED_LEN + header.metadata_len))
}

/// Extrai e decodifica UMA amostra, identificada por `sample_id`. Depois de
/// ler o índice (que cobre o arquivo inteiro, é pequeno), lê e decodifica
/// só os bytes exatos daquela amostra — nenhuma outra amostra é tocada,
/// nem em disco nem em CPU (ver teste
/// `extracting_one_sample_still_works_even_if_another_sample_is_corrupted`
/// em `writer.rs`, que prova isso indiretamente).
/// Repara, SOMENTE NA MEMÓRIA, o STREAMINFO de FLACs gravados por versões
/// antigas do app: `flacenc` 0.5.1 escrevia o último bloco curto (1..15
/// frames) como `min_block_size`, e `claxon` recusa qualquer mínimo < 16.
/// Não altera os bytes do arquivo nem o SHA-256 (a checagem de integridade
/// acontece antes desta função), e preserva `total_samples`/MD5 — só troca
/// os 4 bytes de limites de bloco. Em streams de bloco fixo, o mínimo não
/// inclui o último bloco: usamos o próprio máximo declarado (ou 16 quando o
/// arquivo inteiro é curto). Devolve `true` quando houve reparo.
fn repair_legacy_flac_streaminfo(flac_bytes: &mut [u8]) -> bool {
    // "fLaC" + cabeçalho do primeiro metadata block + STREAMINFO (34 bytes).
    if flac_bytes.len() < 42
        || flac_bytes[0] != b'f'
        || flac_bytes[1] != b'L'
        || flac_bytes[2] != b'a'
        || flac_bytes[3] != b'C'
    {
        return false;
    }
    // O bit mais alto de `flac_bytes[4]` só indica "último bloco"; os 7 bits
    // baixos precisam ser 0 (STREAMINFO).
    if (flac_bytes[4] & 0x7f) != 0 {
        return false;
    }
    let block_len = ((flac_bytes[5] as usize) << 16)
        | ((flac_bytes[6] as usize) << 8)
        | (flac_bytes[7] as usize);
    if block_len < 34 || flac_bytes.len() < 8 + block_len {
        return false;
    }
    let min_block_size = u16::from_be_bytes([flac_bytes[8], flac_bytes[9]]);
    let max_block_size = u16::from_be_bytes([flac_bytes[10], flac_bytes[11]]);
    if min_block_size >= 16 {
        return false;
    }
    let fixed_block_size = max_block_size.max(16);
    flac_bytes[8..10].copy_from_slice(&fixed_block_size.to_be_bytes());
    flac_bytes[10..12].copy_from_slice(&fixed_block_size.to_be_bytes());
    true
}

pub fn extract_sample(path: &std::path::Path, sample_id: &str) -> Result<MrqDecodedSample, MrqError> {
    let file_metadata = read_file_metadata(path)?;
    let (mut file, header) = open_and_validate_header(path)?;
    decode_sample_entry(&mut file, &header, &file_metadata, sample_id)
}

/// Extrai VÁRIAS amostras numa única abertura do arquivo (v0.2.18) — os
/// metadados (JSON inteiro) são lidos UMA vez só, em vez de uma vez por
/// amostra. A exportação SF2 do conversor (`mrqToSf2Export.ts`) pede
/// centenas de amostras de uma biblioteca grande; chamar
/// `extract_sample` uma vez por zona reabria o arquivo e reparseava o
/// JSON inteiro a cada chamada, e a exportação parecia travada por
/// minutos ("fica só girando"). A ordem do vetor de saída segue a ordem
/// de `sample_ids` pedida.
pub fn extract_samples(path: &std::path::Path, sample_ids: &[String]) -> Result<Vec<MrqDecodedSample>, MrqError> {
    let file_metadata = read_file_metadata(path)?;
    let (mut file, header) = open_and_validate_header(path)?;
    let mut out = Vec::with_capacity(sample_ids.len());
    for sample_id in sample_ids {
        out.push(decode_sample_entry(&mut file, &header, &file_metadata, sample_id)?);
    }
    Ok(out)
}

/// Núcleo compartilhado por `extract_sample`/`extract_samples`: localiza a
/// entrada no índice já lido, lê só os bytes FLAC daquela amostra, confere
/// o SHA-256 e decodifica. Recebe o arquivo já aberto e o cabeçalho já
/// validado pra o caminho em lote não reabrir/revalidar nada.
fn decode_sample_entry(
    file: &mut std::fs::File,
    header: &ValidatedHeader,
    file_metadata: &MrqFileMetadata,
    sample_id: &str,
) -> Result<MrqDecodedSample, MrqError> {
    let entry = file_metadata
        .samples
        .iter()
        .find(|s| s.id == sample_id)
        .ok_or_else(|| MrqError::SampleNotFound { sample_id: sample_id.to_string() })?;

    let sample_block_start = format::HEADER_FIXED_LEN + header.metadata_len;
    let abs_offset = sample_block_start
        .checked_add(entry.relative_offset)
        .ok_or_else(|| MrqError::SizeOverflow { sample_id: entry.id.clone() })?;

    file.seek(SeekFrom::Start(abs_offset))?;
    let mut flac_bytes = vec![0u8; entry.length as usize];
    file.read_exact(&mut flac_bytes)?;

    let mut hasher = Sha256::new();
    hasher.update(&flac_bytes);
    let actual_sha256 = format::to_hex(&hasher.finalize());
    if actual_sha256 != entry.sha256 {
        return Err(MrqError::HashMismatchSample { sample_id: entry.id.clone() });
    }

    // Compatibilidade com `.mrq` já gravados (ex.: "Astoria Grand XL 6.1"
    // da foto): corrige em memória o STREAMINFO inválido gerado pelo encoder
    // antigo, sem tocar no arquivo e sem invalidar o hash já conferido acima.
    let repaired_legacy_streaminfo = repair_legacy_flac_streaminfo(&mut flac_bytes);
    let mut flac_reader = claxon::FlacReader::new(std::io::Cursor::new(flac_bytes))
        .map_err(|e| MrqError::DecodeError {
            message: if repaired_legacy_streaminfo {
                format!("{} (STREAMINFO legado reparado em memória)", e)
            } else {
                e.to_string()
            },
        })?;

    // "Metadados inconsistentes" (revisão técnica pós-Fase 10): o SHA-256
    // acima só prova que os BYTES do FLAC não foram adulterados — não prova
    // que o `channels`/`sampleRateHz` do índice JSON bate com o que o
    // próprio cabeçalho STREAMINFO do FLAC de fato contém. Um `.mrq` com
    // metadados corrompidos/editados à mão (ou um bug futuro de escrita)
    // poderia ter um índice que descreve uma amostra estéreo de 44.1kHz
    // apontando pra um FLAC mono de 48kHz de verdade — sem esta checagem,
    // isso seria devolvido como `MrqDecodedSample` rotulado errado pro
    // chamador (JS), que confia nesses campos pra calcular duração/offsets
    // de loop. Falha explícita aqui é melhor que um resultado sutilmente
    // incorreto mais adiante.
    let info = flac_reader.streaminfo();
    if info.channels as u16 != entry.channels {
        return Err(MrqError::MetadataStreamMismatch {
            sample_id: entry.id.clone(),
            field: "channels".to_string(),
            declared: entry.channels.to_string(),
            actual: info.channels.to_string(),
        });
    }
    if info.sample_rate != entry.sample_rate_hz {
        return Err(MrqError::MetadataStreamMismatch {
            sample_id: entry.id.clone(),
            field: "sampleRateHz".to_string(),
            declared: entry.sample_rate_hz.to_string(),
            actual: info.sample_rate.to_string(),
        });
    }

    let bits = flac_reader.streaminfo().bits_per_sample;
    let full_scale = if bits >= 1 { (1i64 << (bits - 1)) as f32 } else { 1.0 };

    let mut interleaved = Vec::new();
    for sample in flac_reader.samples() {
        let s = sample.map_err(|e| MrqError::DecodeError { message: e.to_string() })?;
        interleaved.push((s as f32) / full_scale);
    }

    Ok(MrqDecodedSample {
        sample_id: entry.id.clone(),
        interleaved,
        sample_rate_hz: entry.sample_rate_hz,
        channels: entry.channels,
        bits_per_sample_encoded: entry.bits_per_sample_encoded,
    })
}

/// Confere a integridade do arquivo: SHA-256 de cada amostra contra o
/// índice, e SHA-256 global (tudo exceto o próprio rodapé de 32 bytes)
/// contra o valor gravado no final do arquivo. Só devolve `Err` por
/// problema ESTRUTURAL (cabeçalho/versão/limites/JSON) — um hash que não
/// bate vira dado no relatório (`ok: false`), não uma exceção.
pub fn validate_integrity(path: &std::path::Path) -> Result<MrqIntegrityReport, MrqError> {
    let file_metadata = read_file_metadata(path)?;
    let (mut file, header) = open_and_validate_header(path)?;
    let sample_block_start = format::HEADER_FIXED_LEN + header.metadata_len;

    let mut per_sample = Vec::with_capacity(file_metadata.samples.len());
    for entry in &file_metadata.samples {
        let abs_offset = sample_block_start
            .checked_add(entry.relative_offset)
            .ok_or_else(|| MrqError::SizeOverflow { sample_id: entry.id.clone() })?;
        file.seek(SeekFrom::Start(abs_offset))?;
        let mut bytes = vec![0u8; entry.length as usize];
        file.read_exact(&mut bytes)?;
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let actual = format::to_hex(&hasher.finalize());
        per_sample.push(MrqSampleIntegrity { sample_id: entry.id.clone(), ok: actual == entry.sha256 });
    }

    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let to_hash_len = header.total_len - format::TRAILER_LEN;
    let mut remaining = to_hash_len;
    let mut buf = [0u8; 64 * 1024];
    while remaining > 0 {
        let chunk = remaining.min(buf.len() as u64) as usize;
        file.read_exact(&mut buf[..chunk])?;
        hasher.update(&buf[..chunk]);
        remaining -= chunk as u64;
    }
    let computed_global = format::to_hex(&hasher.finalize());

    let mut trailer = [0u8; format::TRAILER_LEN as usize];
    file.read_exact(&mut trailer)?;
    let stored_global = format::to_hex(&trailer);

    Ok(MrqIntegrityReport { global_ok: computed_global == stored_global, per_sample })
}

#[cfg(test)]
mod tests {
    use super::repair_legacy_flac_streaminfo;

    /// Monta só o começo de um FLAC: marcador + cabeçalho do primeiro bloco
    /// STREAMINFO + os 34 bytes mínimos desse bloco. O suficiente para testar
    /// os quatro bytes de limites de bloco sem precisar de um encoder aqui.
    fn flac_with_stream_info(min_block_size: u16, max_block_size: u16) -> Vec<u8> {
        let mut bytes = vec![0u8; 42];
        bytes[0..4].copy_from_slice(b"fLaC");
        bytes[4] = 0; // STREAMINFO (bit de "último bloco" desligado)
        bytes[5..8].copy_from_slice(&[0, 0, 34]);
        bytes[8..10].copy_from_slice(&min_block_size.to_be_bytes());
        bytes[10..12].copy_from_slice(&max_block_size.to_be_bytes());
        bytes
    }

    fn block_sizes(bytes: &[u8]) -> (u16, u16) {
        (
            u16::from_be_bytes([bytes[8], bytes[9]]),
            u16::from_be_bytes([bytes[10], bytes[11]]),
        )
    }

    #[test]
    fn repairs_legacy_streaminfo_with_short_final_block() {
        let mut bytes = flac_with_stream_info(5, 4096);
        assert!(repair_legacy_flac_streaminfo(&mut bytes));
        assert_eq!(block_sizes(&bytes), (4096, 4096));
    }

    #[test]
    fn repairs_legacy_streaminfo_when_the_whole_file_is_short() {
        let mut bytes = flac_with_stream_info(5, 5);
        assert!(repair_legacy_flac_streaminfo(&mut bytes));
        assert_eq!(block_sizes(&bytes), (16, 16));
    }

    #[test]
    fn leaves_a_valid_streaminfo_untouched() {
        let mut bytes = flac_with_stream_info(4096, 4096);
        assert!(!repair_legacy_flac_streaminfo(&mut bytes));
        assert_eq!(block_sizes(&bytes), (4096, 4096));
    }

    #[test]
    fn refuses_to_patch_non_flac_or_non_streaminfo_data() {
        let mut not_flac = flac_with_stream_info(5, 4096);
        not_flac[0] = b'X';
        assert!(!repair_legacy_flac_streaminfo(&mut not_flac));
        assert_eq!(block_sizes(&not_flac), (5, 4096));

        let mut other_block = flac_with_stream_info(5, 4096);
        other_block[4] = 4; // VORBIS_COMMENT, não STREAMINFO
        assert!(!repair_legacy_flac_streaminfo(&mut other_block));
        assert_eq!(block_sizes(&other_block), (5, 4096));
    }
}
