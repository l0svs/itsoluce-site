-- ═══════════════════════════════════════════════════════════════════
-- Archivage du PDF de chaque facture et note de crédit à son émission
--
-- Le PDF était recalculé à chaque ouverture : un modèle modifié plus tard
-- changeait le rendu d'une ancienne facture. Désormais, à l'émission, le PDF
-- exact est déposé dans un espace privé (factures-archives) avec son
-- empreinte SHA-256. Le fichier ne peut plus être remplacé ni supprimé par
-- l'ERP, et la base refuse de changer le lien une fois posé.
-- pdf_reconstitue = true pour les factures émises avant cette mise en place
-- (PDF recalculé après coup, pas l'original envoyé à l'époque).
-- ═══════════════════════════════════════════════════════════════════

begin;

alter table public.factures
  add column if not exists pdf_chemin      text,
  add column if not exists pdf_sha256      text,
  add column if not exists pdf_archive_le  timestamptz,
  add column if not exists pdf_reconstitue boolean not null default false;

-- Espace de stockage privé, PDF uniquement, 10 Mo max par fichier.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('factures-archives', 'factures-archives', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists factures_archives_lire    on storage.objects;
drop policy if exists factures_archives_deposer on storage.objects;
create policy factures_archives_lire on storage.objects for select to authenticated
  using (bucket_id = 'factures-archives' and public.a_acces(array['factures','devis','clients','gestion']));
create policy factures_archives_deposer on storage.objects for insert to authenticated
  with check (bucket_id = 'factures-archives' and public.peut_ecrire(array['factures','devis','reparations']));
-- Volontairement aucune politique de modification ni de suppression.

create or replace function public.factures_regles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  aujourdhui date := (now() at time zone 'Europe/Brussels')::date;
  emettre boolean := false;
begin
  if TG_OP = 'INSERT' then
    if NEW.type_document = 'note_credit' then
      if NEW.facture_origine_id is null then
        raise exception 'Une note de crédit doit se rapporter à une facture.';
      end if;
      perform 1 from factures o
       where o.id = NEW.facture_origine_id and o.type_document = 'facture'
         and o.emise_le is not null and o.supprime_le is null;
      if not found then
        raise exception 'La facture d''origine doit exister et être émise.';
      end if;
      if NEW.statut not in ('imputee','a_rembourser','remboursee') then
        raise exception 'Statut de note de crédit invalide : %.', NEW.statut;
      end if;
      if coalesce(NEW.total, 0) >= 0 then
        raise exception 'Le montant d''une note de crédit doit être négatif.';
      end if;
    elsif NEW.statut in ('creditee','imputee','a_rembourser','remboursee') then
      raise exception 'Statut réservé aux notes de crédit : %.', NEW.statut;
    end if;
    if NEW.statut = 'annulee' then
      raise exception 'Un brouillon se supprime, il ne s''annule pas.';
    end if;
    NEW.numero   := null;   -- jamais choisi par le navigateur
    NEW.emise_le := null;
    NEW.pdf_chemin      := null;   -- un brouillon n'a pas d'archive
    NEW.pdf_sha256      := null;
    NEW.pdf_archive_le  := null;
    NEW.pdf_reconstitue := false;
    emettre := NEW.statut <> 'brouillon';

  elsif OLD.emise_le is not null then
    -- ── Document émis : contenu figé ──
    if NEW.numero             is distinct from OLD.numero
    or NEW.date_emission      is distinct from OLD.date_emission
    or NEW.emise_le           is distinct from OLD.emise_le
    or NEW.type_document      is distinct from OLD.type_document
    or NEW.facture_origine_id is distinct from OLD.facture_origine_id
    or NEW.lignes             is distinct from OLD.lignes
    or NEW.total              is distinct from OLD.total
    or NEW.remise             is distinct from OLD.remise
    or NEW.acompte            is distinct from OLD.acompte
    or NEW.client_nom         is distinct from OLD.client_nom
    or NEW.client_adresse     is distinct from OLD.client_adresse
    or NEW.client_societe     is distinct from OLD.client_societe
    or NEW.client_tva         is distinct from OLD.client_tva
    or NEW.notes              is distinct from OLD.notes
    or NEW.motif_credit       is distinct from OLD.motif_credit then
      raise exception 'Le document % est émis : son contenu ne peut plus être modifié. Corrige-le avec une note de crédit.', OLD.numero;
    end if;
    if NEW.supprime_le is not null and OLD.supprime_le is null then
      raise exception 'Le document % est émis : il ne peut pas être supprimé. Annule-le avec une note de crédit.', OLD.numero;
    end if;
    if NEW.statut is distinct from OLD.statut then
      if OLD.statut in ('creditee','annulee','imputee','remboursee') then
        raise exception 'Le document % est clôturé (%) : son statut ne change plus.', OLD.numero, OLD.statut;
      end if;
      if OLD.type_document = 'facture' then
        if NEW.statut not in ('envoyee','payee','non_reparable','creditee') then
          raise exception 'Statut impossible pour une facture émise : %.', NEW.statut;
        end if;
        if NEW.statut = 'creditee' then
          perform 1 from factures nc
           where nc.facture_origine_id = OLD.id and nc.type_document = 'note_credit'
             and nc.supprime_le is null;
          if not found then
            raise exception 'Une facture ne passe en « Créditée » que par une note de crédit.';
          end if;
        end if;
      elsif NEW.statut not in ('a_rembourser','remboursee') then
        raise exception 'Statut impossible pour une note de crédit : %.', NEW.statut;
      end if;
    end if;
    -- ── Archive PDF : déposée une seule fois, ensuite définitive ──
    if OLD.pdf_chemin is not null then
      if NEW.pdf_chemin      is distinct from OLD.pdf_chemin
      or NEW.pdf_sha256      is distinct from OLD.pdf_sha256
      or NEW.pdf_archive_le  is distinct from OLD.pdf_archive_le
      or NEW.pdf_reconstitue is distinct from OLD.pdf_reconstitue then
        raise exception 'L''archive PDF du document % est définitive.', OLD.numero;
      end if;
    elsif NEW.pdf_chemin is not null then
      if NEW.pdf_chemin <> to_char(OLD.date_emission, 'YYYY') || '/' || OLD.numero || '.pdf' then
        raise exception 'Chemin d''archive inattendu pour %.', OLD.numero;
      end if;
      if coalesce(NEW.pdf_sha256, '') !~ '^[0-9a-f]{64}$' then
        raise exception 'Empreinte SHA-256 de l''archive invalide.';
      end if;
      perform 1 from storage.objects where bucket_id = 'factures-archives' and name = NEW.pdf_chemin;
      if not found then
        raise exception 'Le fichier d''archive % est introuvable.', NEW.pdf_chemin;
      end if;
      NEW.pdf_archive_le := now();
    else
      NEW.pdf_sha256      := null;
      NEW.pdf_archive_le  := null;
      NEW.pdf_reconstitue := false;
    end if;
    return NEW;

  else
    -- ── Brouillon ──
    if NEW.statut = 'annulee' then
      raise exception 'Un brouillon se supprime, il ne s''annule pas.';
    end if;
    if NEW.statut = 'creditee' then
      raise exception 'Un brouillon ne peut pas être crédité.';
    end if;
    NEW.numero   := OLD.numero;   -- anciens brouillons déjà numérotés : conservé
    NEW.emise_le := null;
    NEW.pdf_chemin      := null;   -- un brouillon n'a pas d'archive
    NEW.pdf_sha256      := null;
    NEW.pdf_archive_le  := null;
    NEW.pdf_reconstitue := false;
    emettre := NEW.statut <> 'brouillon' and NEW.supprime_le is null;
  end if;

  if emettre then
    if coalesce(trim(NEW.client_nom), '') = '' then
      raise exception 'Nom du client manquant : le document ne peut pas être émis.';
    end if;
    if jsonb_typeof(NEW.lignes) is distinct from 'array' or jsonb_array_length(NEW.lignes) = 0 then
      raise exception 'Document sans ligne : il ne peut pas être émis.';
    end if;
    if NEW.numero is null then
      NEW.numero := prochain_numero(case when NEW.type_document = 'note_credit' then 'note_credit' else 'facture' end);
    end if;
    -- L'échéance garde le même délai, compté à partir de l'émission.
    if NEW.date_echeance is not null and NEW.date_emission is not null then
      NEW.date_echeance := aujourdhui + greatest(0, NEW.date_echeance - NEW.date_emission);
    end if;
    NEW.date_emission := aujourdhui;
    NEW.emise_le      := now();
  end if;
  return NEW;
end $$;

revoke execute on function public.factures_regles() from public, anon, authenticated;

commit;
